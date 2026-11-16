// Background drain: advance due jobs stage by stage within a wall-clock budget. Safe to run
// concurrently with UI ticks because every stage runs under the fenced per-job lease.
import { runJobStage } from "./pipeline.server";

// Stages whose single AI call outlasts the ~30s background window (story planning ≈ 80s) run only
// from an open Studio tab (tickJobs); background would be killed mid-call and starve the lease.
export const FOREGROUND_STAGES = ["story_plan"];

export async function drainJobs(budgetMs: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const started = Date.now(); let processed = 0;
  while (Date.now() - started < budgetMs) {
    const { data } = await supabaseAdmin.from("jobs").select("id").in("status", ["queued", "running"]).not("stage", "in", `(${FOREGROUND_STAGES.join(",")})`).lte("next_attempt_at", new Date().toISOString())
      .or(`lock_until.is.null,lock_until.lt.${new Date().toISOString()}`).order("next_attempt_at").limit(3);
    if (!data?.length) break;
    for (const j of data) { if (Date.now() - started > budgetMs) break; await runJobStage(j.id); processed++; }
  }
  return processed;
}
