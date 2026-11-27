import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// Hosting compresses every response at the edge. Never compress a body (gzip, brotli,
// CompressionStream) or set content-encoding here or in a server route: the body gets encoded
// twice and renders garbled.
type WaitUntil = (p: Promise<unknown>) => void;
// Background continuation after the response: raw Worker ctx, srvx/nitro request.waitUntil, or the
// workerd built-in module. Returns null in the Vite dev server (route fallback handles it there).
async function resolveWaitUntil(request: Request, ctx: unknown): Promise<WaitUntil | null> {
  const c = ctx as { waitUntil?: WaitUntil } | null;
  if (typeof c?.waitUntil === "function") return (p) => c.waitUntil!(p);
  const r = request as Request & { waitUntil?: WaitUntil };
  if (typeof r.waitUntil === "function") return (p) => r.waitUntil!(p);
  try {
    const spec = "cloudflare:workers";
    const m = (await import(/* @vite-ignore */ spec)) as { waitUntil?: WaitUntil };
    if (typeof m.waitUntil === "function") return m.waitUntil;
  } catch { /* not on workerd */ }
  return null;
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      // Scheduled job tick: acknowledge at once, keep advancing jobs after the response (waitUntil ~30s; new stages start only in the first 8s).
      if (request.method === "POST" && new URL(request.url).pathname === "/api/public/jobs/tick") {
        const waitUntil = await resolveWaitUntil(request, ctx);
        if (waitUntil) {
        const { authenticateCronRequest } = await import("./integrations/supabase/cron-auth");
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;
        const { drainJobs } = await import("./server/drain.server");
        waitUntil(drainJobs(8_000).catch((e) => console.error("drain failed", e)));
        const { drainLive } = await import("./server/live.server");
        const { drainClipAnalysis } = await import("./server/clip-analysis.server");
        waitUntil(drainClipAnalysis().catch((e) => console.error("clip analysis drain failed", e)));
        waitUntil(drainLive(25_000).catch((e) => console.error("live drain failed", e)));
        return Response.json({ accepted: true }, { status: 202 });
        }
      }
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
