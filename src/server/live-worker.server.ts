// Recorder-worker protocol: the user's own recorder (scripts/live-recorder) holds a rolling buffer of
// streams it is authorized to record, claims due highlights, uploads a vertical MP4 to a signed URL and
// reports completion; the server verifies the file before registering it as a finished job.
import { CLAIM_COLUMNS } from "@/lib/live-claim";
import { inspectMp4 } from "@/lib/mp4-inspect";

export async function hashToken(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
// A highlight is claimable once its 15 s post-roll plus one 10 s segment have been written.
const POST_ROLL_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 3, CLAIM_MS = 15 * 60_000, MAX_BYTES = 80 * 1024 * 1024;

/** PUT proxy for a claimed highlight's MP4. Authenticated by the unguessable per-claim UUID (single highlight, live claim only). */
export async function handleUpload(request: Request): Promise<Response> {
  const fail = (stage: string, status: number, msg: string) => Response.json({ error: `${stage}: ${msg}`, stage }, { status });
  const u = new URL(request.url); const id = u.searchParams.get("upload") ?? "", claim = u.searchParams.get("claim") ?? "";
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(id) || !uuid.test(claim)) return fail("upload_auth", 401, "bad claim");
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const { data: h } = await db.from("live_highlights").select("id,user_id,output_path,claim_until").eq("id", id).eq("claim", claim).eq("status", "claimed").maybeSingle();
  if (!h || !h.output_path) return fail("upload_claim", 409, "claim lost");
  if (h.claim_until && Date.parse(h.claim_until) < Date.now()) return fail("upload_claim", 409, "claim expired");
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) return fail("upload_size", 413, "file too large");
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 1000 || buf.byteLength > MAX_BYTES) return fail("upload_size", 413, `bad size ${buf.byteLength}`);
  const { error } = await db.storage.from("outputs").upload(h.output_path, buf, { contentType: "video/mp4", upsert: true });
  if (error) return fail("upload_storage", 502, error.message.replace(/token=[^&\s]+/g, "token=***").slice(0, 200));
  return Response.json({ ok: true, bytes: buf.byteLength });
}

export async function handleWorker(request: Request): Promise<Response> {
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!/^lrw_[0-9a-f]{64}$/.test(token)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { data: worker } = await db.from("live_workers").select("id,user_id").eq("token_hash", await hashToken(token)).maybeSingle();
  if (!worker) return Response.json({ error: "unauthorized" }, { status: 401 });
  await db.from("live_workers").update({ last_seen_at: new Date().toISOString() }).eq("id", worker.id);
  const body = await request.json().catch(() => ({})) as { action?: string; id?: string; claim?: string; error?: string; retryable?: boolean };
  const uid = worker.user_id;

  if (body.action === "monitors") {
    const { data } = await db.from("live_monitors").select("id,platform,input,live_video_id,channel_id,status,media_mode,recording_url,stream_started_at")
      .eq("user_id", uid).in("media_mode", ["recorder", "recording_url"]).eq("rights_confirmed", true).neq("status", "stopped");
    return Response.json({ monitors: (data ?? []).map((m) => ({ ...m, record_url: m.media_mode === "recording_url" ? m.recording_url
      : m.platform === "twitch" ? `https://www.twitch.tv/${m.channel_id}` : m.live_video_id ? `https://www.youtube.com/watch?v=${m.live_video_id}` : null })) });
  }
  if (String(body.action ?? "").startsWith("folder_") || String(body.action ?? "").startsWith("candidate_")) {
    const { handleFolder } = await import("@/server/local-folder.server");
    return (await handleFolder(db, uid, body)) ?? Response.json({ error: "bad request" }, { status: 400 });
  }
  if (body.action === "status") { // recorder heartbeat: per-monitor buffer/ready/error, shown in Sources
    const list = Array.isArray((body as any).monitors) ? (body as any).monitors.slice(0, 20) : [];
    const at = new Date().toISOString();
    for (const m of list) {
      if (typeof m?.id !== "string") continue;
      const state = { at, version: String((body as any).version ?? "").slice(0, 20), buffer_s: Math.max(0, Math.min(86400, Number(m.buffer_s) || 0)), ready: m.ready === true,
        error: m.error ? String(m.error).slice(0, 300) : null, quality: m.quality ? String(m.quality).slice(0, 60) : null, tools: String((body as any).tools ?? "").slice(0, 200) };
      await db.from("live_monitors").update({ recorder_state: state }).eq("id", m.id).eq("user_id", uid);
    }
    return Response.json({ ok: true });
  }
  if (body.action === "validate_frames") { // semantic check of a chat-spike candidate: real buffer frames → vision; never rate-limited scene log
    const b = body as unknown as { monitor_id?: string; frames?: string[] };
    const { data: mon } = await db.from("live_monitors").select("id").eq("id", String(b.monitor_id ?? "")).eq("user_id", uid).maybeSingle();
    if (!mon) return Response.json({ error: "monitor not found" }, { status: 404 });
    const { classifyFrame, MAX_FRAME_BYTES } = await import("@/server/live-vision.server");
    const frames = (Array.isArray(b.frames) ? b.frames : []).filter((f) => typeof f === "string" && f.length * 0.75 <= MAX_FRAME_BYTES).slice(0, 3);
    const scenes = [];
    for (const f of frames) { try { scenes.push(await classifyFrame(f)); } catch (e) { scenes.push({ game: null, activity: "unavailable", confidence: 0, note: `vision: ${(e as Error).message.slice(0, 100)}` }); } }
    return Response.json({ scenes });
  }
  if (body.action === "frame") { // visual game check from the recorder's buffer; never blocks capture
    const b = body as unknown as { monitor_id?: string; frame_at?: string; jpeg_base64?: string; unavailable?: string };
    if (!b.monitor_id || !b.frame_at || Number.isNaN(Date.parse(b.frame_at))) return Response.json({ error: "bad frame" }, { status: 400 });
    const { MAX_FRAME_BYTES, recordScene } = await import("@/server/live-vision.server");
    if (b.jpeg_base64 && b.jpeg_base64.length * 0.75 > MAX_FRAME_BYTES) return Response.json({ error: "frame too large" }, { status: 413 });
    return Response.json(await recordScene(db, uid, b.monitor_id, new Date(b.frame_at), b.jpeg_base64 ?? null, b.unavailable));
  }
  if (body.action === "event_scan") return handleEventScan(db, uid, body as any);
  if (body.action === "claim") {
    const now = new Date().toISOString();
    const { error: recoveryError } = await db.from("live_highlights")
      .update({ status: "awaiting_media", claim: null, claim_until: null })
      .eq("user_id", uid).eq("status", "claimed").lt("claim_until", now);
    if (recoveryError) return Response.json({ error: "claim recovery failed" }, { status: 503 });
    const { data: due } = await db.from("live_highlights").select(CLAIM_COLUMNS).eq("user_id", uid).eq("status", "awaiting_media")
      .lt("end_at", new Date(Date.now() - POST_ROLL_WAIT_MS).toISOString()).or(`claim_until.is.null,claim_until.lt.${now}`).order("start_at").limit(2);
    const out = [];
    for (const h of due ?? []) {
      if (h.attempts >= MAX_ATTEMPTS) { await db.from("live_highlights").update({ status: "failed", detail: "Превышено число попыток записи" }).eq("id", h.id); continue; }
      const claim = crypto.randomUUID(); const path = `${uid}/live/${h.id}.mp4`;
      const { data: ok } = await db.from("live_highlights").update({ status: "claimed", claim, claim_until: new Date(Date.now() + CLAIM_MS).toISOString(), attempts: h.attempts + 1, output_path: path })
        .eq("id", h.id).eq("status", "awaiting_media").select("id").maybeSingle();
      if (!ok) continue;
      // Upload goes through this app (same host the recorder already reaches): storage's edge rejects the
      // default Python-urllib User-Agent with 403 "error code: 1010", which broke recorder <=2.3 uploads.
      out.push({ ...h, claim, upload_url: `${new URL(request.url).origin}/api/public/live/worker?upload=${h.id}&claim=${claim}` });
    }
    return Response.json({ highlights: out });
  }
  if ((body.action === "complete" || body.action === "fail") && body.id && body.claim) {
    const { data: h } = await db.from("live_highlights").select("*").eq("id", body.id).eq("user_id", uid).eq("claim", body.claim).eq("status", "claimed").maybeSingle();
    if (!h) return Response.json({ error: "claim lost" }, { status: 409 });
    if (body.action === "fail") {
      const retry = body.retryable !== false && h.attempts < MAX_ATTEMPTS;
      await db.from("live_highlights").update({ status: retry ? "awaiting_media" : "unavailable", claim: null, claim_until: null, detail: String(body.error ?? "ошибка записи").slice(0, 300) }).eq("id", h.id);
      return Response.json({ ok: true, retry });
    }
    const r = await finalizeHighlight(db, uid, h, "recorder");
    if (!("error" in r) && (body as any).note) await db.from("live_highlights").update({ detail: String((body as any).note).slice(0, 300) }).eq("id", h.id);
    if ("error" in r) return Response.json({ error: r.error }, { status: 400 });
    return Response.json({ ok: true, job_id: r.job_id });
  }
  return Response.json({ error: "bad request" }, { status: 400 });
}

type Db = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
/** Verify an uploaded highlight MP4 (real video + original audio) and register one finished job per highlight. */
export async function finalizeHighlight(db: Db, uid: string, h: any, source: "recorder" | "tab", durationHint?: number): Promise<{ job_id?: string | undefined } | { error: string }> {
    const { data: file, error } = await db.storage.from("outputs").download(h.output_path!);
    if (error || !file) return { error: "upload missing" };
    if (file.size > MAX_BYTES) return { error: "file too large" };
    let info; try { info = inspectMp4(new Uint8Array(await file.arrayBuffer())); if (!info.video || !info.audio) throw new Error("нужны видео и оригинальный звук"); } catch (e) {
      await db.from("live_highlights").update({ status: "awaiting_media", claim: null, detail: `Неверный MP4: ${(e as Error).message}` }).eq("id", h.id);
      return { error: "invalid mp4" };
    }
    const { data: mon } = await db.from("live_monitors").select("platform,channel_title,input").eq("id", h.monitor_id).single();
    // Durable dedup: one finished job per highlight (idempotency key).
    const { data: job, error: jobError } = await db.from("jobs").upsert({ user_id: uid, idempotency_key: `live:${h.id}`, mode: "link", route: "live", audio_mode: "original", status: "succeeded", stage: "done",
      prompt: `Live highlight · ${mon?.channel_title ?? mon?.input} · ${new Date(h.peak_at).toISOString()}`, target_seconds: Math.min(90, Math.max(10, Math.round(info.durationS || durationHint || 30))),
      output_path: h.output_path, output_mime: "video/mp4", output_bytes: file.size, finished_at: new Date().toISOString(), workflow_version: 2,
      plan: { title: `Хайлайт эфира · ${mon?.channel_title ?? mon?.input}`, live: { highlight_id: h.id, platform: mon?.platform, peak_at: h.peak_at, score: h.score, source } } }, { onConflict: "user_id,idempotency_key" }).select("id").single();
    if (jobError || !job) return { error: "job registration failed" };
    await db.from("live_highlights").update({ status: "done", job_id: job?.id ?? null, claim: null, detail: `MP4 ${info.video.width}×${info.video.height}, ${(info.durationS || durationHint || 0).toFixed(1)} с${source === "tab" ? " · из вкладки Chrome" : ""}` }).eq("id", h.id);
  return { job_id: job?.id };
}

/** Gameplay-event path: successive buffered frames → vision → confident, non-routine, non-repeated event becomes a
 * highlight (trigger=vision) even with zero chatters; overlapping chat only boosts score. Cost bounded by canScan. */
async function handleEventScan(db: Db, uid: string, b: { monitor_id?: string; frames?: string[]; frame_times?: string[] }) {
  const L = await import("@/lib/live-events");
  const times = (b.frame_times ?? []).map((t) => Date.parse(t));
  const frames = (Array.isArray(b.frames) ? b.frames : []).filter((f) => typeof f === "string" && f.length * 0.75 <= 400_000).slice(0, 3);
  if (frames.length < 2 || times.length !== frames.length || times.some(Number.isNaN)) return Response.json({ error: "bad frames" }, { status: 400 });
  const { data: mons } = await db.from("live_monitors").select("id,event_state").eq("user_id", uid);
  const mon = (mons ?? []).find((m) => m.id === b.monitor_id);
  if (!mon) return Response.json({ error: "monitor not found" }, { status: 404 });
  const now = Date.now(); const state = (mon.event_state ?? {}) as any;
  const gate = L.canScan(state, (mons ?? []).filter((m) => m.id !== mon.id).map((m: any) => m.event_state?.scan_at), now);
  if (!gate.ok) return Response.json({ skipped: gate.why });
  let next = { ...state, scan_at: new Date(now).toISOString() };
  await db.from("live_monitors").update({ event_state: next }).eq("id", mon.id);
  let ev; try { ev = await L.classifyEventSafe(frames); } catch (e) { ev = null; }
  if (!ev) return Response.json({ event: null, reason: "кадры: проверка недоступна" });
  const d = L.decideEvent(ev, next, now);
  if (!d.keep) return Response.json({ keep: false, reason: d.reason, event: ev });
  next = L.rememberEvent(next, ev.label, new Date(now).toISOString());
  await db.from("live_monitors").update({ event_state: next }).eq("id", mon.id);
  const start = new Date(Math.min(...times)), end = new Date(Math.max(...times));
  const lo = new Date(start.getTime() - 30_000).toISOString(), hi = new Date(end.getTime() + 30_000).toISOString();
  const { data: near } = await db.from("live_highlights").select("id,status,chatters").eq("monitor_id", mon.id).eq("user_id", uid).lte("start_at", hi).gte("end_at", lo);
  const chatters = Math.max(0, ...(near ?? []).map((h) => h.chatters ?? 0));
  const score = L.eventScore(ev.confidence, chatters), detail = d.reason + (chatters ? ` · чат: ${chatters} уникальных` : " · чат: тихо");
  const pending = (near ?? []).find((h) => h.status === "awaiting_media" || h.status === "timestamp_only");
  if (pending) { // same moment already queued from chat: upgrade it instead of a duplicate clip
    await db.from("live_highlights").update({ trigger: "vision", reason: d.reason, score, detail }).eq("id", pending.id);
    return Response.json({ keep: true, highlight_id: pending.id, merged: true, reason: d.reason });
  }
  if ((near ?? []).some((h) => h.status === "claimed" || h.status === "done")) return Response.json({ keep: false, reason: "уже есть клип этого момента" });
  const { data: h } = await db.from("live_highlights").insert({ user_id: uid, monitor_id: mon.id, start_at: start.toISOString(), end_at: end.toISOString(),
    peak_at: new Date((start.getTime() + end.getTime()) / 2).toISOString(), chatters, emotes: 0, score, status: "awaiting_media", trigger: "vision", reason: d.reason, detail }).select("id").single();
  return Response.json({ keep: true, highlight_id: h?.id, reason: d.reason });
}
