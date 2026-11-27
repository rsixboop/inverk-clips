import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
import { drainJobs } from "@/server/drain.server";
import { drainLive } from "@/server/live.server";

// Scheduled worker tick. On the deployed Worker, src/server.ts answers this path immediately and
// drains in ctx.waitUntil; this handler is the fallback (short budget so the scheduler call is not cut).
export const Route = createFileRoute("/api/public/jobs/tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authFailure = await authenticateCronRequest(request);
        if (authFailure) return authFailure;
        const [processed, live] = await Promise.all([drainJobs(4_000), drainLive(8_000)]);
        // Full analysis drain runs only in deployed waitUntil; avoid slow inference in the fallback.
        return Response.json({ processed, live });
      },
    },
  },
});
