import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { parseOp } from "@/lib/vps-ops";

async function admin() { return (await import("@/integrations/supabase/client.server")).supabaseAdmin; }

/** One-time pairing code, valid 15 minutes; only its hash is stored. */
export const createVpsPairing = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => abc[b % abc.length]).join("");
  const { sha256 } = await import("@/server/vps-agent.server");
  const expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
  const { error } = await (await admin()).from("vps_pairings").insert({ user_id: context.userId, code_hash: await sha256(code), expires_at });
  if (error) throw new Error(error.message);
  return { code, expires_at };
});

export const enqueueVpsOp = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agent_id: z.string().uuid(), op: z.string(), args: z.unknown(), idem_key: z.string().min(8).max(120) }).parse(d))
  .handler(async ({ data, context }) => {
    const v = parseOp(data.op, data.args);
    if (v.op === "buffer.ready_post") throw Error("Используйте tiktokPost: проверка готового клипа обязательна");
    const db = await admin();
    const { data: a } = await db.from("vps_agents").select("id").eq("id", data.agent_id).eq("user_id", context.userId).is("revoked_at", null).maybeSingle();
    if (!a) throw new Error("VPS не подключён");
    // Idempotent: the same idem_key never creates a second command.
    const { error } = await db.from("vps_commands").upsert({ user_id: context.userId, agent_id: a.id, op: v.op, args: v.args as never, idem_key: data.idem_key }, { onConflict: "user_id,idem_key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const tiktokRead = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agent_id: z.string().uuid() }).strict().parse(d))
  .handler(async ({ data, context }) => (await import("@/server/tiktok-buffer.server")).bufferOperation(context.userId, "tiktokRead", data));
export const tiktokRefresh = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agent_id: z.string().uuid() }).strict().parse(d))
  .handler(async ({ data, context }) => (await import("@/server/tiktok-buffer.server")).bufferOperation(context.userId, "tiktokRefresh", data));
export const tiktokStatus = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agent_id: z.string().uuid(), command_id: z.string().uuid().optional(), post_id: z.string().regex(/^[a-f0-9]{24}$/).optional() }).strict().parse(d))
  .handler(async ({ data, context }) => (await import("@/server/tiktok-buffer.server")).bufferOperation(context.userId, "tiktokStatus", data));
export const tiktokPost = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => d)
  .handler(async ({ data, context }) => (await import("@/server/tiktok-buffer.server")).bufferOperation(context.userId, "tiktokPost", data));

export const revokeVpsAgent = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agent_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await (await admin()).from("vps_agents").update({ revoked_at: new Date().toISOString() }).eq("id", data.agent_id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
