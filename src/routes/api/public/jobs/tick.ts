import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { runJobStage } from "@/server/pipeline.server";

// Background worker tick (scheduled). Advances due jobs one stage each; the per-job lease makes
// concurrent ticks from the UI safe.
export const Route = createFileRoute("/api/public/jobs/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data } = await supabaseAdmin.from("jobs").select("id").in("status", ["queued", "running"]).lte("next_attempt_at", new Date().toISOString()).order("next_attempt_at").limit(3);
        // one bounded stage per job, stop starting new work after a time budget
        const started = Date.now(); let processed = 0;
        for (const j of data ?? []) { if (Date.now() - started > 20_000) break; await runJobStage(j.id); processed++; }
        return Response.json({ processed });
      },
    },
  },
});
