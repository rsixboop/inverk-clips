import { BUILTIN_CASE_LOCK_KEY, BUILTIN_CASE_LOCK_PATHS } from "./news-overlays";
import { decode } from "fast-png";
import { falConfigured, falPoll, falSubmit, providerMedia } from "./providers/fal";
import { fetchOutput } from "./output-fetch";
import { nextStateOperation, stateOperation, type AssetState } from "./news-overlay-machine";
import { OVERLAY_ASSET_RESERVATION_USD, validateOverlayIntents } from "./news-overlay-plan";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
type DB=SupabaseClient<Database>;
export async function overlayHash(value: unknown) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
export async function resolveOverlayAsset(db:DB,user:string,batch:string,narration:string,raw:unknown) {
  const intent=validateOverlayIntents([raw],narration).intents[0];
  if(!intent) return {status:"skipped" as const,message:"Объект не соответствует озвучке"};
  if(intent.cached_asset_key===BUILTIN_CASE_LOCK_KEY)return {status:"done" as const,key:BUILTIN_CASE_LOCK_KEY,paths:BUILTIN_CASE_LOCK_PATHS,message:"Готовая иллюстрация из библиотеки"};
  if(intent.cached_asset_key && /^[a-f0-9]{64}$/.test(intent.cached_asset_key)) {
    const cached=await db.from("news_overlay_assets").select("state").eq("user_id",user).eq("asset_key",intent.cached_asset_key).maybeSingle();
    const state=cached.data?.state as unknown as AssetState|undefined;
    if(state?.step===6 && state.paths.length===3){
      const paths=await Promise.all(state.paths.map(async path=>{const r=await db.storage.from("outputs").createSignedUrl(path,3600);if(r.error)throw r.error;return r.data.signedUrl;}));
      return {status:"done" as const,key:intent.cached_asset_key,paths,message:"Подходящие состояния из кэша"};
    }
  }
  const key=await overlayHash({object:intent.object,before:intent.before,action:intent.action,after:intent.after,version:1});
  let {data:row,error}=await db.from("news_overlay_assets").select("*").eq("user_id",user).eq("asset_key",key).maybeSingle();
  if(error) throw error;
  if(!row) {
    if(!falConfigured()) return {status:"skipped" as const,message:"fal не подключён — объект пропущен"};
    const {data:reserved,error:reserveError}=await db.rpc("reserve_news_overlay",{p_user:user,p_batch:batch,p_asset:key,p_cost:OVERLAY_ASSET_RESERVATION_USD,p_state:{intent,step:0,paths:[]} as unknown as Json});
    if(reserveError) throw reserveError;
    if(!reserved) return {status:"skipped" as const,message:"Лимит объектов $1 достигнут — пропущен"};
    const read=await db.from("news_overlay_assets").select("*").eq("user_id",user).eq("asset_key",key).single();if(read.error)throw read.error;row=read.data;
  }
  const state=row.state as unknown as AssetState;
  if(state.step===6 && state.paths.length===3) {
    const paths=await Promise.all(state.paths.map(async path=>{const {data,error}=await db.storage.from("outputs").createSignedUrl(path,3600);if(error)throw error;return data.signedUrl;}));
    return {status:"done" as const,key,paths,message:"Готовые состояния из кэша"};
  }
  if(row.phase==="submitting") return {status:"skipped" as const,key,message:`Неизвестный исход отправки ${key}; повтор запрещён`};
  if(row.phase==="failed") return {status:"skipped" as const,key,message:state.error ?? "Объект отклонён"};
  if(row.phase==="polling" && Date.now()-(state.claimedAt ?? 0)<60000) return {status:"pending" as const,key,requestId:state.requestId,message:"Объект проверяется другим запросом"};
  const operation=stateOperation(state);if(!operation)return {status:"skipped" as const,message:"Непригодное состояние"};
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
      return {status:"pending" as const,key,requestId,message:`fal ${state.step+1}/6 · ${requestId}`};
    }
    const result=await falPoll(operation.model,state.requestId);
    if(result.state!=="done") {await write(state,"ready");return {status:"pending" as const,key,requestId:state.requestId,message:"fal обрабатывает объект"};}
    const url=providerMedia(state.step%2===0?result.result["images"]?.[0]?.url:result.result["image"]?.url);
    let path:string|undefined;
    if(state.step%2===1) {
      const bytes=await fetchOutput(url,"story",{maxBytes:6_000_000,timeoutMs:12000});
      // Read dimensions before decode to avoid a decompression-memory bomb.
      const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      if(bytes.length<26 || view.getUint32(0)!==0x89504e47 || view.getUint32(16)>1536 || view.getUint32(20)>1536) throw new Error("PNG слишком большой или повреждён");
      const png=decode(bytes); if(png.channels!==4 || !png.data.some((v,i)=>i%4===3 && v===0) || !png.data.some((v,i)=>i%4===3 && v>128)) throw new Error("Нет настоящего прозрачного объекта");
      path=`${user}/news-overlays/${key}/${Math.floor(state.step/2)}.png`;
      const uploaded=await db.storage.from("outputs").upload(path,bytes,{contentType:"image/png",upsert:true});if(uploaded.error)throw uploaded.error;
    }
    await write(nextStateOperation(state,url,path),"ready");
    return {status:"pending" as const,key,message:`Состояние сохранено ${state.step+1}/6`};
  } catch(error) {
    // A paid submit may have reached fal: retain the submission barrier forever.
    const message=(error as Error).message;
    const transient=/сеть|таймаут|429|временная/i.test(message);
    await write({...state,error:message},state.requestId?(transient?"ready":"failed"):"submitting");
    return {status:"skipped" as const,key,requestId:state.requestId,message:(error as Error).message};
  }
}