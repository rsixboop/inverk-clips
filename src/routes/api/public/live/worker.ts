import { createFileRoute } from "@tanstack/react-router";
import { handleUpload, handleWorker } from "@/server/live-worker.server";

// Recorder worker API. Public path, but every call is authenticated by a per-user worker token (hash lookup).
export const Route = createFileRoute("/api/public/live/worker")({
  server: { handlers: { POST: async ({ request }) => {
    if (new URL(request.url).searchParams.has("clip")) {
      const { latestClip } = await import("@/server/phil-clips.server");
      return latestClip(request);
    }
    return handleWorker(request);
  }, PUT: async ({ request }) => handleUpload(request) } },
});
