import { BUILTIN_CASE_LOCK_KEY, BUILTIN_CASE_LOCK_PATHS } from "./news-overlays";
import { decode } from "fast-png";
import { falConfigured, falPoll, falSubmit, providerMedia, queueBase } from "./providers/fal";
import { fetchOutput } from "./output-fetch";
import { assetDone, nextStateOperation, stateOperation, stepOutputUrl, type AssetState } from "./news-overlay-machine";
import { OVERLAY_ASSET_RESERVATION_USD, validateOverlayIntents } from "./news-overlay-plan";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
type DB=SupabaseClient<Database>;
export async function overlayHash(value: unknown) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
const signAsset=async(db:DB,key:string,state:AssetState,message:string)=>{
  const urls=await Promise.all(state.paths.map(async path=>{const r=await db.storage.from("outputs").createSignedUrl(path,3600);if(r.error)throw r.error;return r.data.signedUrl;}));
  // v2: one cutout still for every state + fal-generated alpha WebM carrying the object's own motion.
  return state.version===2?{status:"done" as const,key,paths:[urls[0]!,urls[0]!,urls[0]!],motion:urls[1],message}:{status:"done" as const,key,paths:urls,message};
};
export async function resolveOverlayAsset(db:DB,user:string,batch:string,narration:string,raw:unknown) {
  const intent=validateOverlayIntents([raw],narration).intents[0];
  if(!intent) return {status:"skipped" as const,message:"Объект не соответствует озвучке"};
  if(intent.cached_asset_key===BUILTIN_CASE_LOCK_KEY)return {status:"done" as const,key:BUILTIN_CASE_LOCK_KEY,paths:BUILTIN_CASE_LOCK_PATHS,message:"Готовая иллюстрация из библиотеки"};
  if(intent.cached_asset_key && /^[a-f0-9]{64}$/.test(intent.cached_asset_key)) {
    const cached=await db.from("news_overlay_assets").select("state").eq("user_id",user).eq("asset_key",intent.cached_asset_key).maybeSingle();
    const state=cached.data?.state as unknown as AssetState|undefined;
    if(assetDone(state)) return signAsset(db,intent.cached_asset_key,state!,"Подходящий объект из кэша");
  }
  const key=await overlayHash({object:intent.object,before:intent.before,action:intent.action,after:intent.after,version:2});
  let {data:row,error}=await db.from("news_overlay_assets").select("*").eq("user_id",user).eq("asset_key",key).maybeSingle();
  if(error) throw error;
  if(!row) {
    if(!falConfigured()) return {status:"skipped" as const,message:"fal не подключён — объект пропущен"};
    const {data:reserved,error:reserveError}=await db.rpc("reserve_news_overlay",{p_user:user,p_batch:batch,p_asset:key,p_cost:OVERLAY_ASSET_RESERVATION_USD,p_state:{intent,version:2,step:0,paths:[]} as unknown as Json});
    if(reserveError) throw reserveError;
    if(!reserved) return {status:"skipped" as const,message:"Лимит объектов $1 достигнут — пропущен"};
    const read=await db.from("news_overlay_assets").select("*").eq("user_id",user).eq("asset_key",key).single();if(read.error)throw read.error;row=read.data;
  }
  const state=row.state as unknown as AssetState;
  if(assetDone(state)) return signAsset(db,key,state,"Готовый объект из кэша");
  if(row.phase==="submitting") return {status:"skipped" as const,key,message:`Неизвестный исход отправки ${key}; повтор запрещён`};
  if(row.phase==="failed") return {status:"skipped" as const,key,message:state.error ?? "Объект отклонён"};
  if(row.phase==="polling" && Date.now()-(state.claimedAt ?? 0)<60000) return {status:"pending" as const,key,requestId:state.requestId,message:"Объект проверяется другим запросом"};
  const operation=stateOperation(state);if(!operation)return {status:"skipped" as const,message:"Непригодное состояние"};
  queueBase(operation.model); // local allow-list check before the submission barrier: a refusal here never reaches fal
  const claim=crypto.randomUUID();
  const nextPhase=state.requestId?"polling":"submitting";
  const claimed=await db.from("news_overlay_assets").update({phase:nextPhase,claim,state:{...state,claimedAt:Date.now()} as unknown as Json}).eq("user_id",user).eq("asset_key",key).eq("phase",row.phase).select("asset_key");
  if(claimed.error)throw claimed.error;
  if(!claimed.data.length)return {status:"pending" as const,key,message:"Объект уже обрабатывается"};
  const write=async(value:AssetState,phase:string)=>{const {error}=await db.from("news_overlay_assets").update({state:value as unknown as Json,phase,claim:null}).eq("user_id",user).eq("asset_key",key).eq("claim",claim);if(error)throw error;};
  try {
    if(!state.requestId) {
      const requestId=await falSubmit(operation.model,operation.input);
      await write({...state,requestId,requests:[...(state.requests ?? []),requestId]},"ready");
      return {status:"pending" as const,key,requestId,message:`fal ${state.step+1}/4 · ${operation.model} · ${requestId}`};
    }
    const result=await falPoll(operation.model,state.requestId);
    if(result.state!=="done") {await write(state,"ready");return {status:"pending" as const,key,requestId:state.requestId,message:"fal обрабатывает объект"};}
    const url=providerMedia(stepOutputUrl(state.step,result.result));
    let path:string|undefined;
    if(state.step===1) {
      const bytes=await fetchOutput(url,"story",{maxBytes:6_000_000,timeoutMs:12000});
      // Read dimensions before decode to avoid a decompression-memory bomb.
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      if(bytes.length<26 || view.getUint32(0)!==0x89504e47 || view.getUint32(16)>1536 || view.getUint32(20)>1536) throw new Error("PNG слишком большой или повреждён");
      const png=decode(bytes); if(png.channels!==4 || !png.data.some((v,i)=>i%4===3 && v===0) || !png.data.some((v,i)=>i%4===3 && v>128)) throw new Error("Нет настоящего прозрачного объекта");
      path=`${user}/news-overlays/${key}/still.png`;
      const uploaded=await db.storage.from("outputs").upload(path,bytes,{contentType:"image/png",upsert:true});if(uploaded.error)throw uploaded.error;
    }
    if(state.step===3) {
      const bytes=await fetchOutput(url,"story",{maxBytes:25_000_000,timeoutMs:20000});
      // WebM/Matroska EBML magic; alpha itself is verified when the browser decodes frames.
      if(bytes.length<1000 || new DataView(bytes.buffer,bytes.byteOffset,4).getUint32(0)!==0x1a45dfa3) throw new Error("fal вернул не WebM с прозрачностью");
      path=`${user}/news-overlays/${key}/motion.webm`;
      const uploaded=await db.storage.from("outputs").upload(path,bytes,{contentType:"video/webm",upsert:true});if(uploaded.error)throw uploaded.error;
    }
    await write(nextStateOperation(state,url,path),"ready");
    return {status:"pending" as const,key,message:`Этап сохранён ${state.step+1}/4`};
  } catch(error) {
    // A paid submit may have reached fal: retain the submission barrier forever.
    const message=(error as Error).message;
    const transient=/сеть|таймаут|429|временная/i.test(message);
    await write({...state,error:message},state.requestId?(transient?"ready":"failed"):"submitting");
    return {status:"skipped" as const,key,requestId:state.requestId,message:(error as Error).message};
  }
}