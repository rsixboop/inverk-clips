import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { FAL, falConfigured, falSubmit, falPoll } from "@/lib/providers/fal";
type Db = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
export async function enqueueClipAnalysis(db:Db,owner:string,jobId:string,path:string) {
  const {error}=await db.from("clip_analysis").upsert({user_id:owner,job_id:jobId,output_path:path},{onConflict:"job_id,output_path",ignoreDuplicates:true});
  if(error)console.error("clip analysis enqueue failed",error.code);
}
const media=z.object({id:z.string().uuid(),claim:z.string().uuid(),duration_s:z.number().min(.5).max(180),audio:z.string().min(44).max(8_000_000).regex(/^[A-Za-z0-9+/=]+$/),frames:z.array(z.object({second:z.number().min(0).max(180),jpeg:z.string().max(240000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/)})).min(1).max(8)});
export async function analysisWorker(db:Db,owner:string,body:Record<string,unknown>) {
  const now=new Date().toISOString();
  const {data:control}=await db.from("recorder_controls").select("paused").eq("user_id",owner).maybeSingle();
  if(control?.paused)return Response.json({paused:true});
  if(body['action']==="analysis_claim") {
    const {data:r}=await db.from("clip_analysis").select("id,output_path").eq("user_id",owner).eq("state","awaiting_media").order("created_at").limit(1).maybeSingle();
    if(!r)return Response.json({items:[]});
    const claim=crypto.randomUUID();
    const {data:ok}=await db.from("clip_analysis").update({state:"extracting",lease:claim,lease_until:new Date(Date.now()+10*60_000).toISOString()}).eq("id",r.id).eq("state","awaiting_media").select("id").maybeSingle();
    if(!ok)return Response.json({items:[]});
    const signed=await db.storage.from("outputs").createSignedUrl(r.output_path,900);
    if(signed.error) {await db.from("clip_analysis").update({state:"unavailable",error:"Stored MP4 unavailable"}).eq("id",r.id).eq("lease",claim);return Response.json({items:[]});}
    return Response.json({items:[{id:r.id,claim,url:signed.data.signedUrl}]});
  }
  if(body['action']==="analysis_fail") {
    const b=z.object({id:z.string().uuid(),claim:z.string().uuid(),error:z.string().max(300)}).parse(body);
    await db.from("clip_analysis").update({state:"unavailable",error:b.error,lease:null,lease_until:null,analyzed_at:now}).eq("id",b.id).eq("user_id",owner).eq("lease",b.claim).eq("state","extracting");
    return Response.json({ok:true});
  }
  const b=media.parse(body);
  if(b.frames.some(f=>f.second>b.duration_s))return Response.json({error:"Frame exceeds MP4 duration"},{status:400});
  const {data:r}=await db.from("clip_analysis").select("id,lease_until").eq("id",b.id).eq("user_id",owner).eq("state","extracting").eq("lease",b.claim).maybeSingle();
  if(!r||!r.lease_until||Date.parse(r.lease_until)<Date.now())return Response.json({error:"Analysis claim expired"},{status:409});
  const bytes=Uint8Array.from(atob(b.audio),c=>c.charCodeAt(0));
  if(new TextDecoder().decode(bytes.subarray(0,4))!=="RIFF"||new TextDecoder().decode(bytes.subarray(8,12))!=="WAVE")return Response.json({error:"Expected extracted WAV"},{status:400});
  const up=await db.storage.from("outputs").upload(`${owner}/analysis/${r.id}.wav`,bytes,{contentType:"audio/wav",upsert:true});
  if(up.error)return Response.json({error:"Analysis audio upload failed"},{status:502});
  const {error}=await db.from("clip_analysis").update({state:"queued",frames:b.frames,lease:null,lease_until:null,next_attempt_at:now}).eq("id",r.id).eq("lease",b.claim);
  return Response.json({ok:!error});
}
export async function drainClipAnalysis() {
  const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
  const now=new Date().toISOString();
  // Extraction is read-only and free to repeat; ambiguous provider submissions/vision are never replayed.
  await db.from("clip_analysis").update({state:"awaiting_media",lease:null,lease_until:null,error:"Recorder extraction heartbeat expired"}).eq("state","extracting").lt("lease_until",now);
  await db.from("clip_analysis").update({state:"unknown",error:"Analysis interrupted; provider outcome unknown, not automatically replayed"}).in("state",["submitting","analyzing"]).lt("lease_until",now);
  const {data:rows}=await db.from("clip_analysis").select("*").in("state",["queued","transcribing","visual"]).lte("next_attempt_at",now).or(`lease_until.is.null,lease_until.lt.${now}`).order("next_attempt_at").limit(6);
  for(const r of rows??[]) {
    const {data:control}=await db.from("recorder_controls").select("paused").eq("user_id",r.user_id).maybeSingle();if(control?.paused)continue;
    const lease=crypto.randomUUID();const {data:ok}=await db.from("clip_analysis").update({lease,lease_until:new Date(Date.now()+120_000).toISOString()}).eq("id",r.id).eq("state",r.state).or(`lease_until.is.null,lease_until.lt.${now}`).select("id").maybeSingle();if(!ok)continue;
    const save=async(p:Database["public"]["Tables"]["clip_analysis"]["Update"])=>{const {error}=await db.from("clip_analysis").update(p).eq("id",r.id).eq("lease",lease);if(error)throw Error("Analysis state persistence failed");};
    try {
      if(r.state==="queued") {
        if(!falConfigured()){await save({state:"visual",error:"Speech unavailable: FAL_KEY missing",lease:null,lease_until:null});return;}
        const signed=await db.storage.from("outputs").createSignedUrl(`${r.user_id}/analysis/${r.id}.wav`,3600);if(signed.error)throw Error("Extracted audio unavailable");
        await save({state:"submitting"}); // durable pre-submit barrier
        const id=await falSubmit(FAL.whisper,{audio_url:signed.data.signedUrl,task:"transcribe",chunk_level:"word",diarize:false});
        await save({state:"transcribing",request_id:id,next_attempt_at:new Date(Date.now()+60_000).toISOString(),lease:null,lease_until:null});
      } else if(r.state==="transcribing"&&r.request_id) {
        const poll=await falPoll(FAL.whisper,r.request_id);
        if(poll.state!=="done"){await save({next_attempt_at:new Date(Date.now()+60_000).toISOString(),lease:null,lease_until:null});return;}
        const words=(poll.result['chunks']??[]).flatMap((c:{text?:string;timestamp?:number[]})=>typeof c.text==="string"&&c.timestamp?.length===2&&c.timestamp.every(Number.isFinite)?[{word:c.text,start:c.timestamp[0],end:c.timestamp[1],speaker:"unknown"}]:[]);
        await save({state:"visual",words,lease:null,lease_until:null});
      } else {
        await save({state:"analyzing"});
        const {describeFrames}=await import("./clip-description.server");
        const frames=z.array(media.shape.frames.element).parse(r.frames);
        const speech=Array.isArray(r.words)?r.words.map((w)=>{const v=w as {start?:number;word?:string};return `${v.start}s ${v.word}`;}).join(" ").slice(0,16000):"unavailable";
        const result=await describeFrames({frames,speech});
        await save({state:"done",description:result.description,analyzed_at:new Date().toISOString(),lease:null,lease_until:null});
      }
    }catch {await save({state:r.state==="queued"||r.state==="visual"?"unknown":"unavailable",error:"Speech/visual service unavailable or outcome unknown; no automatic paid replay",analyzed_at:new Date().toISOString(),lease:null,lease_until:null});}
    return; // one bounded provider operation per existing scheduled tick
  }
}
