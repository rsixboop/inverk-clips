import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { OVERLAY_ALIGN_RESERVATION_USD } from "./news-overlay-plan";
import type { Json } from "@/integrations/supabase/types";

export const resolveNewsOverlay=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator(input=>z.object({batch:z.string().regex(/^[a-f0-9]{64}$/),narration:z.string().max(140),intent:z.unknown()}).parse(input))
 .handler(async({data,context})=>{
   const {supabaseAdmin}=await import("@/integrations/supabase/client.server");
   const {resolveOverlayAsset}=await import("./news-overlay.server");
   return resolveOverlayAsset(supabaseAdmin,context.userId,data.batch,data.narration,data.intent);
 });

export const alignNewsSpeech=createServerFn({method:"POST"}).middleware([requireSupabaseAuth])
 .inputValidator(input=>z.object({batch:z.string().regex(/^[a-f0-9]{64}$/),audio:z.string().max(8_000_000).optional(),mime:z.enum(["audio/wav","audio/mpeg","audio/mp4"]).default("audio/wav")}).parse(input))
 .handler(async({data,context})=>{
   const {supabaseAdmin:db}=await import("@/integrations/supabase/client.server");
   const {falPoll,falSubmit,FAL}=await import("./providers/fal");
   const key=`speech-${data.batch}`,user=context.userId;
   const reserved=await db.rpc("reserve_news_overlay",{p_user:user,p_batch:data.batch,p_asset:key,p_cost:OVERLAY_ALIGN_RESERVATION_USD,p_state:{}});if(reserved.error)throw reserved.error;
   if(!reserved.data)return {status:"skipped" as const,message:"Лимит $1: синхронизация пропущена"};
   const read=await db.from("news_overlay_assets").select("*").eq("user_id",user).eq("asset_key",key).single();if(read.error)throw read.error;
   const row=read.data,state=row.state as {requestId?:string;claimedAt?:number;words?:{word:string;start:number;end:number}[]};
   if(state.words)return {status:"done" as const,words:state.words};
   if(row.phase==="submitting")return {status:"skipped" as const,message:"Исход отправки распознавания неизвестен; повтор запрещён"};
   if(row.phase==="failed")return {status:"skipped" as const,message:"Распознавание не удалось"};
   if(row.phase==="polling" && Date.now()-(state.claimedAt ?? 0)<60000)return {status:"pending" as const};
   const claim=crypto.randomUUID();
   const claimed=await db.from("news_overlay_assets").update({phase:state.requestId?"polling":"submitting",claim,state:{...state,claimedAt:Date.now()}}).eq("user_id",user).eq("asset_key",key).eq("phase",row.phase).select("asset_key");if(claimed.error)throw claimed.error;
   if(!claimed.data.length)return {status:"pending" as const};
   const write=async(value:Json,phase:string)=>{const r=await db.from("news_overlay_assets").update({state:value,phase,claim:null}).eq("user_id",user).eq("asset_key",key).eq("claim",claim);if(r.error)throw r.error;};
   try{
     if(!state.requestId){
       if(!data.audio) {await write({},"ready");return {status:"need_audio" as const};}
       const bytes=Uint8Array.from(atob(data.audio),c=>c.charCodeAt(0));
       const path=`${user}/news-overlays/${key}/voice`;
       const upload=await db.storage.from("outputs").upload(path,bytes,{contentType:data.mime,upsert:true});if(upload.error)throw upload.error;
       const signed=await db.storage.from("outputs").createSignedUrl(path,3600);if(signed.error)throw signed.error;
       const requestId=await falSubmit(FAL.whisper,{audio_url:signed.data.signedUrl,task:"transcribe",chunk_level:"word",diarize:false});
       await write({requestId},"ready");return {status:"pending" as const,requestId};
     }
     const result=await falPoll(FAL.whisper,state.requestId);
     if(result.state!=="done"){await write(state as Json,"ready");return {status:"pending" as const,requestId:state.requestId};}
     const words=(result.result["chunks"] ?? []).flatMap((c:{text?:string;timestamp?:number[]})=>typeof c.text==="string" && c.timestamp?.length===2 && c.timestamp.every(Number.isFinite)?[{word:c.text,start:c.timestamp[0] ?? 0,end:c.timestamp[1] ?? 0}]:[]);
     await write({requestId:state.requestId,words},"ready");return {status:"done" as const,words};
   }catch(error){await write(state as Json,state.requestId?"failed":"submitting");return {status:"skipped" as const,message:(error as Error).message};}
 });