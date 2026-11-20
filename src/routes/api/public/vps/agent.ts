import { createFileRoute } from "@tanstack/react-router";
import { handleVpsAgent } from "@/server/vps-agent.server";

// VPS agent API. Public path; every call except one-time pairing is authenticated by the agent token (hash lookup).
export const Route = createFileRoute("/api/public/vps/agent")({
  server: { handlers: { POST: async ({ request }) => handleVpsAgent(request) } },
});
