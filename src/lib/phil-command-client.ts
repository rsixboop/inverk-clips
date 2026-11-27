import { supabase } from "@/integrations/supabase/client";
import { fields, editable } from "./phil-operations";
import { tickJobs, providerStatus, createJob, jobAction, selectCandidates, pickClip, getOutputUrl, addUrlSource, saveStoryFeedback, setJobBudget } from "./jobs.functions";
import { describeClipFrames, liveStatus, addMonitor, setMediaMode, monitorAction, tickLive, highlightUrl, candidateUrl } from "./live.functions";
import { resolveNewsOverlay, alignNewsSpeech } from "./news-overlay.functions";
import { findNewswire, scriptFromArticle, findGtaNews } from "./news-script.functions";
import { submitNewsVoice, pollNewsVoice } from "./news-voice.functions";
import { enqueueVpsOp } from "./vps.functions";
const actions = { tickJobs, providerStatus, createJob, jobAction, selectCandidates, pickClip, getOutputUrl, addUrlSource, saveStoryFeedback, setJobBudget, liveStatus, addMonitor, setMediaMode, monitorAction, tickLive, highlightUrl, candidateUrl, resolveNewsOverlay, alignNewsSpeech, findNewswire, scriptFromArticle, findGtaNews, submitNewsVoice, pollNewsVoice, enqueueVpsOp };
const db = supabase as any;
async function inspectClip(id:string, source:string) {
  if (source !== "live" && source !== "local") throw Error("Expected source live or local");
  const {url} = await (source==="live" ? highlightUrl : candidateUrl)({data:{id}});
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  const waitFor = (event:string, start:()=>void) => new Promise<void>((resolve,reject)=>{
    const controller = new AbortController();
    const finish = (error?:string) => {
      clearTimeout(timer);
      controller.abort();
      if (error) reject(Error(error)); else resolve();
    };
    const timer = setTimeout(()=>finish("Video timed out: "+event),15000);
    video.addEventListener(event,()=>finish(),{signal:controller.signal});
    video.addEventListener("error",()=>finish("MP4 decode failed"),{signal:controller.signal});
    start();
  });
  try {
    await waitFor("loadeddata",()=>{video.src=url;});
    const duration=video.duration;
    if (!Number.isFinite(duration) || duration<=0 || !video.videoWidth) throw Error("Invalid MP4");
    const canvas=document.createElement("canvas");
    const scale=Math.min(1,640/Math.max(video.videoWidth,video.videoHeight));
    canvas.width=Math.max(1,Math.round(video.videoWidth*scale));
    canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
    const context=canvas.getContext("2d");
    if (!context) throw Error("Canvas unavailable");
    const count=Math.min(10,Math.max(1,Math.ceil(duration/8)));
    const frames=[];
    for(let i=0;i<count;i++){
      const second=(i+0.5)*duration/count;
      await waitFor("seeked",()=>{video.currentTime=second;});
      context.drawImage(video,0,0,canvas.width,canvas.height);
      frames.push({second,jpeg:canvas.toDataURL("image/jpeg",0.65)});
    }
    return {...await describeClipFrames({data:{frames}}),duration,frames:count,audio_analyzed:false};
  } finally {video.removeAttribute("src");video.load();}
}
async function transcribeClip(id:string,source:string,owner:string) {
  if (!["live","local"].includes(source) || !/^[a-f0-9-]{36}$/i.test(id)) throw Error("Invalid clip identifier");
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode([owner,source,id,"dialogue-v1"].join("/")));
  const batch=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
  let state=await alignNewsSpeech({data:{batch}});
  if(state.status==="need_audio"){
    const {url}=await (source==="live"?highlightUrl:candidateUrl)({data:{id}});
    const res=await fetch(url,{signal:AbortSignal.timeout(60000)});
    if(!res.ok) throw Error("Could not download clip audio");
    const rate=16000;
    const decoder=new OfflineAudioContext(1,1,rate);
    const decoded=await decoder.decodeAudioData(await res.arrayBuffer());
    if(decoded.duration>180) throw Error("Dialogue analysis supports clips up to three minutes");
    const renderer=new OfflineAudioContext(1,decoded.length,rate);
    const track=renderer.createBufferSource();
    track.buffer=decoded;
    track.connect(renderer.destination);
    track.start();
    const samples=(await renderer.startRendering()).getChannelData(0);
    const wav=new Uint8Array(44+samples.length*2);
    const view=new DataView(wav.buffer);
    const tag=(at:number,s:string)=>wav.set(new TextEncoder().encode(s),at);
    tag(0,"RIFF");view.setUint32(4,wav.length-8,true);tag(8,"WAVE");tag(12,"fmt ");
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
    tag(36,"data");view.setUint32(40,wav.length-44,true);
    for(let i=0;i<samples.length;i++) view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]??0))*32767),true);
    const parts:string[]=[];
    for(let i=0;i<wav.length;i+=16384) parts.push(String.fromCharCode(...wav.subarray(i,i+16384)));
    state=await alignNewsSpeech({data:{batch,audio:btoa(parts.join("")),mime:"audio/wav"}});
  }
  for(let attempt=0;state.status==="pending" && attempt<30;attempt++){
    await new Promise(resolve=>setTimeout(resolve,3000));
    state=await alignNewsSpeech({data:{batch}});
  }
  if(state.status==="pending") throw Error("Recognition still running; call transcribeClip again for the same clip to collect the existing job");
  if(state.status!=="done") throw Error("message" in state ? String(state.message) : "Transcription unavailable");
  return {words:state.words,speakers_identified:false};
}
async function execute(operation: string, data: Record<string,any>, owner: string) {
  if (operation === 'transcribeClip') return transcribeClip(data['id'],data['source'],owner);
  if (operation === 'inspectClip') return inspectClip(data['id'],data['source']);
  if (Object.hasOwn(actions, operation)) {
    const call = actions[operation as keyof typeof actions] as (input:any)=>Promise<unknown>;
    return call({data});
  }
  const table = String(data["table"]);
  if (!Object.hasOwn(fields, table)) throw Error("Unknown table");
  const source = db.from(table);
  let query;
  if (operation === "records.list") {
    query = source.select(fields[table]).eq("user_id",owner).order("id");
    if (data["id"]) query = query.eq("id",data["id"]);
    const offset = Math.max(0,Math.floor(Number(data["offset"])||0));
    query = query.range(offset,offset+24);
  } else if (operation === "records.delete" && data["id"]) {
    query = source.delete().eq("user_id",owner).eq("id",data["id"]).select("id").single();
  } else {
    const allowed = Object.hasOwn(editable,table) ? (editable[table] ?? '').split(",") : [];
    if (!data["values"] || !Object.keys(data["values"]).length || Object.keys(data["values"]).some(key=>!allowed.includes(key))) throw Error("Invalid columns");
    if (operation === "records.create") query = source.insert({...data["values"], user_id:owner}).select("id").single();
    else if (operation === "records.update" && data["id"]) query = source.update(data["values"]).eq("user_id",owner).eq("id",data["id"]).select("id").single();
    else throw Error("Invalid record operation");
  }
  const result = await query;
  if (result.error) throw Error(result.error.message);
  return result.data;
}
export function servePhilCommands() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  async function poll() {
    try {
      const {data:{session}} = await supabase.auth.getSession();
      if (!session || stopped) return;
      const {data} = await db.rpc("phil_claim_command");
      const job = data?.[0];
      if (!job) return;
      let success = false;
      let outcome;
      try {
        outcome = await execute(job.operation,job.payload,session.user.id);
        success = true;
      } catch (e) { outcome = {message:e instanceof Error ? e.message : "Operation failed"}; }
      await db.rpc("phil_finish_command",{command_id:job.id,success,outcome:outcome ?? {}});
    } finally {
      if (!stopped) timer = setTimeout(() => void poll().catch(() => {}),5000);
    }
  }
  void poll().catch(() => {});
  return () => { stopped = true; clearTimeout(timer); };
}
