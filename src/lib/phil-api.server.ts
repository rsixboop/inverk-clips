import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { operations, fields, editable } from "./phil-operations";
import { hashToken } from "@/server/live-worker.server";
const db = supabaseAdmin as any;
const reply = (status:number, value:unknown) => Response.json(value,{status,headers:{"cache-control":"no-store"}});
const recordOps = ["records.list","records.create","records.update","records.delete"];
export async function philApi(request:Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer phc_[a-f0-9]{64}$/.test(authorization)) return reply(401,{error:"Invalid token"});
  const lookup = await db.from("live_workers").select("user_id").eq("label","phil-read").eq("token_hash",await hashToken(authorization.slice(7))).maybeSingle();
  if (lookup.error) return reply(503,{error:"Token lookup unavailable"});
  if (!lookup.data) return reply(401,{error:"Unknown token"});
  const owner = lookup.data.user_id;
  if (new URL(request.url).searchParams.get("phil")==="identity") return reply(200,{owner});
  const body = await request.json().catch(()=>null);
  if (!body || typeof body.operation!=="string") return reply(400,{error:"Missing operation"});
  if (body.operation==="catalog") return reply(200,{operations,recordOps,fields,editable});
  if (body.operation === "clips.library") {
    const { clipLibrary } = await import("@/server/clip-library.server");
    try { return reply(200, {state:"done", result:await clipLibrary(owner, body.payload)}); }
    catch (e) { return reply(400, {error:e instanceof Error ? e.message : "Clip library unavailable"}); }
  }
  if (body.operation.startsWith("recorder.")) {
    const { recorderOperation, recorderReads, recorderWrites } = await import("@/server/recorder-control.server");
    try {
      if (recorderReads.includes(body.operation)) return reply(200,{state:"done",result:await recorderOperation(owner,body.operation,body.payload)});
      if (!recorderWrites.includes(body.operation)) return reply(400,{error:"Unknown recorder operation"});
      const key=body.request_key;
      if(typeof key!=="string"||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) return reply(400,{error:"Expected UUID request_key"});
      if(!body.payload||typeof body.payload!=="object"||Array.isArray(body.payload)||JSON.stringify(body.payload).length>64000)return reply(400,{error:"Invalid payload"});
      const ins=await db.from("phil_app_commands").insert({owner_id:owner,request_key:key,operation:body.operation,payload:body.payload,state:"running"}).select("id").maybeSingle();
      if(ins.error&&ins.error.code!=="23505")return reply(503,{error:"Queue unavailable"});
      if(!ins.data) {
        const old=await db.from("phil_app_commands").select("operation,payload,state,result").eq("owner_id",owner).eq("request_key",key).maybeSingle();
        if(!old.data)return reply(503,{error:"Queue unavailable"});
        if(old.data.operation!==body.operation||!sameJson(old.data.payload,body.payload))return reply(409,{error:"Request key already used"});
        return reply(200,{request_key:key,state:old.data.state,result:old.data.result});
      }
      let result;let state="done";
      try {result=await recorderOperation(owner,body.operation,body.payload,key);} catch(e){state="failed";result={error:e instanceof Error?e.message:"Recorder operation failed"};}
      await db.from("phil_app_commands").update({state,result}).eq("id",ins.data.id).eq("owner_id",owner);
      return reply(200,{request_key:key,state,result});
    }catch(e){return reply(400,{error:e instanceof Error?e.message:"Recorder operation failed"});}
  }
  if (["tiktokRead", "tiktokRefresh", "tiktokPost", "tiktokStatus"].includes(body.operation)) {
    try {
      const { bufferOperation } = await import("@/server/tiktok-buffer.server");
      return reply(200, { state: "done", result: await bufferOperation(owner, body.operation, body.payload) });
    } catch (e) { return reply(400, { error: e instanceof Error ? e.message : "Buffer operation failed" }); }
  }
  if (body.operation === "records.list") {
    const data = body.payload ?? {};
    if (typeof data.table !== "string" || !Object.hasOwn(fields,data.table)) return reply(400,{error:"Unknown table"});
    const offset = Math.max(0,Math.floor(Number(data.offset)||0));
    let query = db.from(data.table).select(fields[data.table]).eq("user_id",owner).order("id");
    if (data.id) query = query.eq("id",data.id);
    const result = await query.range(offset,offset+24);
    return result.error ? reply(502,{error:"Read failed"}) : reply(200,{state:"done",result:result.data});
  }
  const key = body.request_key;
  if (typeof key!=="string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) return reply(400,{error:"Expected UUID request_key"});
  const read = () => db.from("phil_app_commands").select("operation,payload,state,result,created_at").eq("owner_id",owner).eq("request_key",key).maybeSingle();
  if (body.operation!=="status") {
    if (!Object.hasOwn(operations,body.operation) && !recordOps.includes(body.operation)) return reply(400,{error:"Unknown operation"});
    if (!body.payload || typeof body.payload!=="object" || Array.isArray(body.payload) || JSON.stringify(body.payload).length>64000) return reply(400,{error:"Invalid payload"});
    const inserted = await db.from("phil_app_commands").insert({owner_id:owner,request_key:key,operation:body.operation,payload:body.payload});
    if (inserted.error && inserted.error.code!=="23505") return reply(503,{error:"Queue unavailable"});
  }
  const row = await read();
  if (row.error) return reply(503,{error:"Queue unavailable"});
  if (!row.data) return reply(404,{error:"Unknown request"});
  if (body.operation!=="status" && (row.data.operation!==body.operation || !sameJson(body.payload,row.data.payload))) return reply(409,{error:"Request key already used"});
  let state = row.data.state;
  if (state==="queued" && Date.now()-Date.parse(row.data.created_at)>=120000) state="expired";
  return reply(200,{request_key:key,state,result:row.data.result});
}
function sameJson(a:any,b:any):boolean {
  if (a===b) return true;
  if (!a || !b || typeof a!=="object" || typeof b!=="object" || Array.isArray(a)!==Array.isArray(b)) return false;
  return Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(k=>Object.hasOwn(b,k)&&sameJson(a[k],b[k]));
}
