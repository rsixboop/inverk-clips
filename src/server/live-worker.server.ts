// Recorder-worker protocol: the user's own recorder (scripts/live-recorder) holds a rolling buffer of
// streams it is authorized to record, claims due highlights, uploads a vertical MP4 to a signed URL and
// reports completion; the server verifies the file before registering it as a finished job.
import { captureEligible } from "@/lib/recorder-policy";
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
  if (Number(request.headers.get("content-length") ?? 0) > 10_000_000) return Response.json({ error: "body too large" }, { status: 413 });
  const body = await request.json().catch(() => ({})) as { action?: string; id?: string; claim?: string; error?: string; retryable?: boolean };
  const uid = worker.user_id;

  if (String(body.action ?? "").startsWith("analysis_")) {
    const { analysisWorker } = await import("./clip-analysis.server");
    try { return await analysisWorker(db, uid, body as Record<string, unknown>); } catch { return Response.json({ error: "Invalid analysis request" }, { status: 400 }); }
  }
  const { data: control } = await db.from("recorder_controls").select("paused").eq("user_id", uid).maybeSingle();
  if (body.action === "monitors") {
    const { data } = await db.from("live_monitors").select("id,platform,input,live_video_id,channel_id,status,media_mode,recording_url,stream_started_at,enabled,archived_at,rights_confirmed,observation,observed_at,confirmed_live_at")
      .eq("user_id", uid).in("media_mode", ["recorder", "recording_url"]).eq("rights_confirmed", true).neq("status", "stopped");
    return Response.json({ paused: control?.paused ?? false, monitors: (data ?? []).map((m) => ({ ...m, capture_eligible: captureEligible(m, control?.paused ?? false), record_url: m.media_mode === "recording_url" ? m.recording_url
      : m.platform === "twitch" ? `https://www.twitch.tv/${m.channel_id}` : m.live_video_id ? `https://www.youtube.com/watch?v=${m.live_video_id}` : null })) });
  }
  if (control?.paused && body.action !== "status" && body.action !== "complete" && body.action !== "fail") return Response.json({ paused: true, highlights: [] });
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
        error: m.error ? String(m.error).slice(0, 300) : null, capture_state: String(m.capture_state ?? "").slice(0, 40), last_segment_at: m.last_segment_at && !Number.isNaN(Date.parse(m.last_segment_at)) ? m.last_segment_at : null, retry_at: m.retry_at && !Number.isNaN(Date.parse(m.retry_at)) ? m.retry_at : null, error_stage: String(m.error_stage ?? "").slice(0, 40), quality: m.quality ? String(m.quality).slice(0, 60) : null, tools: String((body as any).tools ?? "").slice(0, 200) };
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
  if (body.action === "speech_submit" || body.action === "speech_poll") { // rolling-buffer speech transcription (fal whisper), opt-in on the recorder
    const b = body as unknown as { monitor_id?: string; start_at?: string; audio_base64?: string; request_id?: string };
    const { FAL, falPoll, falSubmit } = await import("@/lib/providers/fal");
    try {
      if (body.action === "speech_poll") {
        if (!b.request_id || !/^[\w-]{8,80}$/.test(b.request_id)) return Response.json({ error: "bad request_id" }, { status: 400 });
        const r = await falPoll(FAL.whisper, b.request_id);
        if (r.state !== "done") return Response.json({ state: "pending" });
        const words = (r.result["chunks"] ?? []).flatMap((x: any) => typeof x.text === "string" && x.timestamp?.length === 2 && x.timestamp.every(Number.isFinite) ? [{ text: x.text, start: x.timestamp[0], end: x.timestamp[1] }] : []);
        return Response.json({ state: "done", words });
      }
      if (!b.monitor_id || !b.start_at || Number.isNaN(Date.parse(b.start_at)) || !b.audio_base64) return Response.json({ error: "bad speech chunk" }, { status: 400 });
      if (b.audio_base64.length * 0.75 > 2_000_000) return Response.json({ error: "audio too large" }, { status: 413 });
      const path = `${uid}/speech/${b.monitor_id.replace(/[^\w-]/g, "")}/${Date.parse(b.start_at)}.m4a`;
      const up = await db.storage.from("outputs").upload(path, Buffer.from(b.audio_base64, "base64"), { contentType: "audio/mp4", upsert: true });
      if (up.error) return Response.json({ error: `storage: ${up.error.message}` }, { status: 500 });
      const signed = await db.storage.from("outputs").createSignedUrl(path, 3600);
      if (signed.error) return Response.json({ error: "sign failed" }, { status: 500 });
      const rid = await falSubmit(FAL.whisper, { audio_url: signed.data.signedUrl, task: "transcribe", chunk_level: "segment", diarize: false });
      return Response.json({ request_id: rid });
    } catch (e) { return Response.json({ error: `speech: ${(e as Error).message.slice(0, 160)}` }, { status: 502 }); }
  }
  if (body.action === "event_scan") return handleEventScan(db, uid, body as any);
  if (body.action === "claim") {
    const now = new Date().toISOString();
    // A crashed worker must not hold claimed clips forever. No records are erased.
    await db.from("live_highlights").update({ status: "awaiting_media", claim: null, claim_until: null }).eq("user_id", uid).eq("status", "claimed").lt("claim_until", now).lt("attempts", MAX_ATTEMPTS);
    await db.from("live_highlights").update({ status: "failed", claim: null, claim_until: null, detail: "Recorder claim expired after maximum attempts" }).eq("user_id", uid).eq("status", "claimed").lt("claim_until", now).gte("attempts", MAX_ATTEMPTS);
    const { data: eligible } = await db.from("live_monitors").select("id").eq("user_id", uid).eq("enabled", true).is("archived_at", null).eq("rights_confirmed", true).in("media_mode", ["recorder", "recording_url"]);
    if (!eligible?.length) return Response.json({ highlights: [] });
    const { data: due } = await db.from("live_highlights").select(CLAIM_COLUMNS).eq("user_id", uid).in("monitor_id", eligible.map(m => m.id)).eq("status", "awaiting_media")
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
    if (!h || (h.claim_until && Date.parse(h.claim_until) < Date.now())) return Response.json({ error: "claim lost or expired" }, { status: 409 });
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
    const { data: job } = await db.from("jobs").upsert({ user_id: uid, idempotency_key: `live:${h.id}`, mode: "link", route: "live", audio_mode: "original", status: "completed", stage: "done",
      prompt: `Live highlight · ${mon?.channel_title ?? mon?.input} · ${new Date(h.peak_at).toISOString()}`, target_seconds: Math.min(90, Math.max(10, Math.round(info.durationS || durationHint || 30))),
      output_path: h.output_path, output_mime: "video/mp4", output_bytes: file.size, finished_at: new Date().toISOString(), workflow_version: 2,
      plan: { title: `Хайлайт эфира · ${mon?.channel_title ?? mon?.input}`, live: { highlight_id: h.id, platform: mon?.platform, peak_at: h.peak_at, score: h.score, source } } }, { onConflict: "user_id,idempotency_key" }).select("id").single();
    if (!job) return { error: "job registration failed" };
    const { enqueueClipAnalysis } = await import("./clip-analysis.server");
    await enqueueClipAnalysis(db, uid, job.id, h.output_path);
    await db.from("live_monitors").update({ latest_file: { id: String(h.id), job_id: job.id, output_path: String(h.output_path), updated_at: new Date().toISOString() } }).eq("id", h.monitor_id).eq("user_id", uid);
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
