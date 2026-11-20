// Outbound VPS agent API. The agent authenticates with a token issued by one-time owner pairing; only its hash is stored.
import { parseOp } from "@/lib/vps-ops";

async function admin() { return (await import("@/integrations/supabase/client.server")).supabaseAdmin; }
export async function sha256(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
const err = (stage: string, msg: string, status = 400) => Response.json({ error: msg, stage }, { status });
const RESEND_MS = 120_000;

export async function handleVpsAgent(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > 4_000_000) return err("size", "payload too large", 413);
  let body: any; try { body = JSON.parse(text || "{}"); } catch { return err("parse", "bad json"); }
  const db = await admin();
  const now = new Date().toISOString();

  if (body.action === "pair") {
    if (typeof body.code !== "string" || body.code.length < 8) return err("pair", "code required");
    const { data: p } = await db.from("vps_pairings").select("id,user_id,expires_at,used_at").eq("code_hash", await sha256(body.code.trim().toUpperCase())).maybeSingle();
    if (!p || p.used_at || Date.parse(p.expires_at) < Date.now()) return err("pair", "code invalid, used or expired", 401);
    const { data: used } = await db.from("vps_pairings").update({ used_at: now }).eq("id", p.id).is("used_at", null).select("id");
    if (!used?.length) return err("pair", "code already used", 401);
    const token = "vpa_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
    const { data: a, error } = await db.from("vps_agents").insert({ user_id: p.user_id, name: String(body.name ?? "vps").slice(0, 60), token_hash: await sha256(token), agent_version: String(body.version ?? "").slice(0, 20) }).select("id").single();
    if (error) return err("pair", "store failed", 500);
    return Response.json({ token, agent_id: a.id, server_ts: now });
  }

  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token.startsWith("vpa_")) return err("auth", "unauthorized", 401);
  const { data: agent } = await db.from("vps_agents").select("id,user_id,revoked_at").eq("token_hash", await sha256(token)).maybeSingle();
  if (!agent || agent.revoked_at) return err("auth", "unauthorized", 401);

  if (body.action === "heartbeat") {
    await db.from("vps_agents").update({ last_seen_at: now, last_server_ts: typeof body.last_server_ts === "string" ? body.last_server_ts : null,
      agent_version: String(body.version ?? "").slice(0, 20), services: body.services ?? {}, info: body.info ?? {} }).eq("id", agent.id);
    const { data: cmds } = await db.from("vps_commands").select("id,op,args,status,sent_at").eq("agent_id", agent.id).in("status", ["pending", "sent"]).order("created_at").limit(10);
    const due = (cmds ?? []).filter((c) => c.status === "pending" || !c.sent_at || Date.now() - Date.parse(c.sent_at) > RESEND_MS);
    const out = [];
    for (const c of due) {
      try { const v = parseOp(c.op, c.args); out.push({ id: c.id, op: v.op, args: v.args }); }
      catch (e) { await db.from("vps_commands").update({ status: "failed", error: "rejected by allowlist", done_at: now }).eq("id", c.id); continue; }
    }
    if (out.length) await db.from("vps_commands").update({ status: "sent", sent_at: now }).in("id", out.map((c) => c.id));
    return Response.json({ server_ts: now, commands: out });
  }

  if (body.action === "result") {
    if (typeof body.id !== "string") return err("result", "id required");
    const status = body.status === "done" ? "done" : "failed";
    await db.from("vps_commands").update({ status, result: body.result ?? null, error: body.error ? String(body.error).slice(0, 500) : null, done_at: now })
      .eq("id", body.id).eq("agent_id", agent.id).in("status", ["pending", "sent"]);
    return Response.json({ ok: true, server_ts: now });
  }

  if (body.action === "mirror") {
    const kind = String(body.kind ?? "");
    if (!/^(table:[A-Za-z0-9_]{1,64}|buffer:(channels|posts|error)|schema)$/.test(kind)) return err("mirror", "kind not allowed");
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 1000) : [];
    const recs = rows.filter((r: any) => r && r.key != null).map((r: any) => ({ agent_id: agent.id, user_id: agent.user_id, kind, row_key: String(r.key).slice(0, 200), data: r.data ?? {}, updated_at: now }));
    for (let i = 0; i < recs.length; i += 200) {
      const { error } = await db.from("vps_mirror").upsert(recs.slice(i, i + 200), { onConflict: "agent_id,kind,row_key" });
      if (error) return err("mirror", "store failed", 500);
    }
    if (body.full) await db.from("vps_mirror").delete().eq("agent_id", agent.id).eq("kind", kind).lt("updated_at", now);
    return Response.json({ ok: true, stored: recs.length, server_ts: now });
  }
  return err("action", "unknown action");
}
