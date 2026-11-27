import { z } from "zod";
import { parseLiveInput } from "@/lib/live-detect";
import { captureEligible, recorderHealth } from "@/lib/recorder-policy";
import { supabaseAdmin as db } from "@/integrations/supabase/client.server";
const page = z.object({cursor:z.string().uuid().optional(),limit:z.number().int().min(1).max(50).default(25),monitor_id:z.string().uuid().optional()});
export const recorderReads = ["recorder.list","recorder.status","recorder.streams","recorder.clips","recorder.analysis"];
export const recorderWrites = ["recorder.add","recorder.start","recorder.stop","recorder.archive","recorder.pause","recorder.resume"];
export async function recorderOperation(owner:string, operation:string, payload:unknown, requestKey?:string) {
  if (["recorder.pause","recorder.resume"].includes(operation)) {
    const {error}=await db.from("recorder_controls").upsert({user_id:owner,paused:operation==="recorder.pause",updated_at:new Date().toISOString()});
    if(error) throw Error("Pause state unavailable"); return {paused:operation==="recorder.pause"};
  }
  if(operation==="recorder.add") {
    const d=z.object({input:z.string().min(2).max(300),rights:z.boolean().default(false),media_mode:z.enum(["timestamp_only","recorder"]).default("timestamp_only")}).parse(payload);
    const p=parseLiveInput(d.input); if(!p) throw Error("Invalid Twitch/YouTube channel or live URL");
    if(d.media_mode==="recorder"&&!d.rights) throw Error("Explicit recording rights confirmation required");
    if(!requestKey) throw Error("Missing request key");
    const {data,error}=await db.from("live_monitors").upsert({id:requestKey,user_id:owner,input:d.input.trim(),platform:p.platform,channel_id:p.platform==="twitch"?p.login:null,media_mode:d.media_mode,rights_confirmed:d.rights,status:"resolving"},{onConflict:"id",ignoreDuplicates:true}).select("id").maybeSingle();
    if(error) throw Error("Monitor could not be added");
    if(!data) {const existing=await db.from("live_monitors").select("id").eq("id",requestKey).eq("user_id",owner).maybeSingle(); if(!existing.data) throw Error("Monitor key conflict");}
    return {id:requestKey};
  }
  if(["recorder.start","recorder.stop","recorder.archive"].includes(operation)) {
    const {id}=z.object({id:z.string().uuid()}).parse(payload);
    const now=new Date().toISOString(); const start=operation==="recorder.start";
    const {data,error}=await db.from("live_monitors").update(start?{enabled:true,status:"resolving",observation:"unknown",observation_error:null,next_poll_at:now,stopped_at:null,live_chat_id:null,page_token:null,lease:null,lease_until:null}:{enabled:false,status:"stopped",stopped_at:now,lease:null,lease_until:null,...(operation==="recorder.archive"?{archived_at:now}:{})}).eq("id",id).eq("user_id",owner).is("archived_at",null).select("id").maybeSingle();
    if(error||!data) throw Error("Monitor missing or archived"); return {id,enabled:start,archived:operation==="recorder.archive"};
  }
  if(operation==="recorder.analysis") {
    const {job_id}=z.object({job_id:z.string().uuid()}).parse(payload);
    const r=await db.from("clip_analysis").select("id,job_id,state,words,description,request_id,error,created_at,analyzed_at").eq("user_id",owner).eq("job_id",job_id).maybeSingle();
    if(r.error) throw Error("Analysis read unavailable"); return r.data;
  }
  const d=page.parse(payload??{});
  if(["recorder.list","recorder.status"].includes(operation)) {
    const [control,workers,agents]=await Promise.all([
      db.from("recorder_controls").select("paused").eq("user_id",owner).maybeSingle(),
      db.from("live_workers").select("id,last_seen_at,label").eq("user_id",owner).eq("label","recorder").order("last_seen_at",{ascending:false,nullsFirst:false}).limit(5),
      db.from("vps_agents").select("id,agent_version,last_seen_at,services").eq("user_id",owner).is("revoked_at",null).order("last_seen_at",{ascending:false}).limit(5)]);
    if(control.error||workers.error||agents.error) throw Error("Recorder diagnostics unavailable");
    let q=db.from("live_monitors").select("id,platform,input,channel_id,channel_title,enabled,archived_at,status,status_detail,media_mode,rights_confirmed,observation,observed_at,observation_error,last_poll_at,next_poll_at,recorder_state,stream_started_at").eq("user_id",owner).order("id").limit(d.limit+1);
    if(d.cursor) q=q.gt("id",d.cursor); const r=await q; if(r.error) throw Error("Monitor read unavailable");
    const rows=(r.data??[]).slice(0,d.limit); const ids=rows.map(m=>m.id);
    const latest=ids.length?await db.from("live_highlights").select("id,monitor_id,job_id,output_path,updated_at").eq("user_id",owner).eq("status","done").in("monitor_id",ids).order("updated_at",{ascending:false}).limit(100):{data:[]};
    const paused=control.data?.paused??false;
    return {paused,workers:workers.data,agents:agents.data,diagnostic:"Service active is not recorder health. Stale heartbeat: inspect recorder unit logs, configured app URL and lrw token; VPS agent pairing is separate.",items:rows.map(m=>({...m,health:recorderHealth(m.recorder_state as Parameters<typeof recorderHealth>[0]),capture_eligible:captureEligible(m,paused),latest_successful_file:latest.data?.find(h=>h.monitor_id===m.id)??null})),next_cursor:(r.data??[]).length>d.limit?rows.at(-1)?.id:null};
  }
  if(operation==="recorder.streams") {
    let q=db.from("live_streams").select("id,monitor_id,stream_key,started_at,ended_at,last_observed_at").eq("user_id",owner).order("id").limit(d.limit+1);
    if(d.cursor)q=q.gt("id",d.cursor);if(d.monitor_id)q=q.eq("monitor_id",d.monitor_id);const r=await q;if(r.error)throw Error("Stream read unavailable");
    const items=(r.data??[]).slice(0,d.limit);return {items,next_cursor:(r.data??[]).length>d.limit?items.at(-1)?.id:null};
  }
  if(operation==="recorder.clips") {
    let q=db.from("live_highlights").select("id,monitor_id,status,start_at,end_at,peak_at,job_id,output_path,detail,reason,trigger,updated_at").eq("user_id",owner).order("id").limit(d.limit+1);
    if(d.cursor)q=q.gt("id",d.cursor);if(d.monitor_id)q=q.eq("monitor_id",d.monitor_id);const r=await q;if(r.error)throw Error("Clip read unavailable");const items=(r.data??[]).slice(0,d.limit);
    const jobs=items.flatMap(h=>h.job_id?[h.job_id]:[]);const analysis=jobs.length?await db.from("clip_analysis").select("job_id,state,analyzed_at,error").eq("user_id",owner).in("job_id",jobs):{data:[]};
    return {items:items.map(h=>({...h,analysis:analysis.data?.find(a=>a.job_id===h.job_id)??null})),next_cursor:(r.data??[]).length>d.limit?items.at(-1)?.id:null};
  }
  throw Error("Unknown recorder operation");
}
