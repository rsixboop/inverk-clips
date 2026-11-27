import { supabase } from "@/integrations/supabase/client";
import { fields, editable } from "./phil-operations";
import { tickJobs, providerStatus, createJob, jobAction, selectCandidates, pickClip, getOutputUrl, addUrlSource, saveStoryFeedback, setJobBudget } from "./jobs.functions";
import { liveStatus, addMonitor, setMediaMode, monitorAction, tickLive, highlightUrl, candidateUrl } from "./live.functions";
import { resolveNewsOverlay, alignNewsSpeech } from "./news-overlay.functions";
import { findNewswire, scriptFromArticle, findGtaNews } from "./news-script.functions";
import { submitNewsVoice, pollNewsVoice } from "./news-voice.functions";
import { enqueueVpsOp } from "./vps.functions";
const actions = { tickJobs, providerStatus, createJob, jobAction, selectCandidates, pickClip, getOutputUrl, addUrlSource, saveStoryFeedback, setJobBudget, liveStatus, addMonitor, setMediaMode, monitorAction, tickLive, highlightUrl, candidateUrl, resolveNewsOverlay, alignNewsSpeech, findNewswire, scriptFromArticle, findGtaNews, submitNewsVoice, pollNewsVoice, enqueueVpsOp };
const db = supabase as any;
async function execute(operation: string, data: Record<string,any>, owner: string) {
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
