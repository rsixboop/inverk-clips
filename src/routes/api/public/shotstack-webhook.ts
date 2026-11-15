import { createFileRoute } from "@tanstack/react-router";
import { runJobStage, signJob } from "@/server/pipeline.server";

// Shotstack render callback. We never trust the body: verify an HMAC bound to the job id, then
// re-poll the provider through the normal pipeline step.
export const Route = createFileRoute("/api/public/shotstack-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const u = new URL(request.url);
        const job = u.searchParams.get("job") ?? "";
        const sig = u.searchParams.get("sig") ?? "";
        if (!/^[0-9a-f-]{36}$/.test(job) || !process.env["WEBHOOK_SIGNING_SECRET"]) return new Response("bad request", { status: 400 });
        const expected = await signJob(job);
        if (sig.length !== expected.length) return new Response("forbidden", { status: 403 });
        let diff = 0; for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
        if (diff !== 0) return new Response("forbidden", { status: 403 });
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.from("jobs").update({ next_attempt_at: new Date().toISOString() }).eq("id", job).eq("stage", "render_wait");
        await runJobStage(job); // one bounded stage; finalize follows on the next tick
        return Response.json({ ok: true });
      },
    },
  },
});
