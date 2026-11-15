import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { processJob } from "@/server/pipeline.server";

// Background worker tick (scheduled). Advances due jobs one stage each; the per-job lease makes
// concurrent ticks from the UI safe.
export const Route = createFileRoute("/api/public/jobs/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data } = await supabaseAdmin.from("jobs").select("id").in("status", ["queued", "running"]).lte("next_attempt_at", new Date().toISOString()).order("updated_at").limit(5);
        for (const j of data ?? []) for (let i = 0; i < 4; i++) await processJob(supabaseAdmin, j.id); // run consecutive due stages
        return Response.json({ processed: data?.length ?? 0 });
      },
    },
  },
});
