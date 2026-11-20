// Pure rules for the VPS agent: the only operations the app may ask it to run, and the connection badge.
import { z } from "zod";

export const VPS_OPS = {
  "reddit.add": z.object({ url: z.string().url().max(500).refine((u) => /^https:\/\/(www\.|old\.)?(reddit\.com|redd\.it)\//.test(u), "Нужна ссылка reddit.com"), title: z.string().max(300).optional(), note: z.string().max(500).optional() }).strict(),
  "collect.set_interval": z.object({ minutes: z.number().int().min(5).max(1440) }).strict(),
  "service.restart": z.object({ unit: z.string().regex(/^[a-zA-Z0-9@._-]+\.service$/).max(80) }).strict(),
  "sync.now": z.object({}).strict(),
  "buffer.refresh": z.object({}).strict(),
} as const;
export type VpsOp = keyof typeof VPS_OPS;
export const VPS_OP_NAMES = Object.keys(VPS_OPS) as VpsOp[];

/** Throws on any operation outside the allowlist or with unexpected arguments. Nothing here publishes. */
export function parseOp(op: string, args: unknown): { op: VpsOp; args: Record<string, unknown> } {
  if (!(op in VPS_OPS)) throw new Error(`Операция не разрешена: ${op}`);
  return { op: op as VpsOp, args: VPS_OPS[op as VpsOp].parse(args ?? {}) as Record<string, unknown> };
}

export const HEARTBEAT_S = 30;
export type AgentState = "never" | "online" | "stale" | "revoked";
export function agentState(a: { last_seen_at: string | null; revoked_at?: string | null } | null | undefined, now = Date.now()): AgentState {
  if (!a) return "never";
  if (a.revoked_at) return "revoked";
  if (!a.last_seen_at) return "stale";
  return now - Date.parse(a.last_seen_at) <= HEARTBEAT_S * 2.5 * 1000 ? "online" : "stale";
}

export type ServiceInfo = { active: string; sub?: string; result?: string; since?: string };
/** Services report separately from the heartbeat: an online agent can still have failed units. */
export function failedServices(services: Record<string, ServiceInfo> | null | undefined): string[] {
  return Object.entries(services ?? {}).filter(([, s]) => s.active === "failed" || (s.result && s.result !== "success")).map(([u]) => u);
}
