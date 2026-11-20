// Pure rules for the VPS agent: the only operations the app may ask it to run, and the connection badge.
import { z } from "zod";

const REDDIT = /^https:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})(?:\/|$)/i;
/** Reddit post URL → studio story key (stories.id = t3_<id>). */
export function parseRedditUrl(url: string): { community: string; id: string } | null {
  const m = REDDIT.exec(url.trim());
  return m ? { community: m[1]!, id: `t3_${m[2]!.toLowerCase()}` } : null;
}

export const VPS_OPS = {
  "reddit.add": z.object({ url: z.string().max(500).refine((u) => !!parseRedditUrl(u), "Нужна ссылка reddit.com/r/<sub>/comments/<id>/"), title: z.string().max(300).optional(), body: z.string().max(40000).optional() }).strict(),
  "collect.set": z.object({ enabled: z.boolean(), minutes: z.number().int().min(5).max(1440) }).strict(),
  "service.restart": z.object({ unit: z.string().regex(/^[a-zA-Z0-9@._-]+\.service$/).max(80) }).strict(),
  "sync.now": z.object({}).strict(),
  "buffer.refresh": z.object({}).strict(),
  // Explicit user click only; Buffer saves it as a draft (saveToDraft), never publishes.
  "buffer.create_draft": z.object({ channel_id: z.string().regex(/^[a-f0-9]{24}$/), text: z.string().min(1).max(2200), video_url: z.string().max(1000).regex(/^https:\/\/[^\s]+$/, "Нужна HTTPS ссылка на видео") }).strict(),
} as const;
export type VpsOp = keyof typeof VPS_OPS;
export const VPS_OP_NAMES = Object.keys(VPS_OPS) as VpsOp[];

export function parseOp(op: string, args: unknown): { op: VpsOp; args: Record<string, unknown> } {
  if (!(op in VPS_OPS)) throw new Error(`Операция не разрешена: ${op}`);
  return { op: op as VpsOp, args: VPS_OPS[op as VpsOp].parse(args ?? {}) as Record<string, unknown> };
}

/** Mirror kinds the server accepts; only non-secret, allowlisted fields are sent by the agent. */
export const MIRROR_KINDS = ["stories", "settings", "buffer:channels", "buffer:posts", "buffer:error"] as const;

export const HEARTBEAT_S = 30;
export type AgentState = "never" | "online" | "stale" | "revoked";
export function agentState(a: { last_seen_at: string | null; revoked_at?: string | null } | null | undefined, now = Date.now()): AgentState {
  if (!a) return "never";
  if (a.revoked_at) return "revoked";
  if (!a.last_seen_at) return "stale";
  return now - Date.parse(a.last_seen_at) <= HEARTBEAT_S * 2.5 * 1000 ? "online" : "stale";
}

export type ServiceInfo = { active: string; sub?: string; result?: string; since?: string };
export function failedServices(services: Record<string, ServiceInfo> | null | undefined): string[] {
  return Object.entries(services ?? {}).filter(([, s]) => s.active === "failed" || (s.result && s.result !== "success")).map(([u]) => u);
}
