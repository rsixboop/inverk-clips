// Recorder-worker protocol: the user's own recorder (scripts/live-recorder) holds a rolling buffer of
// streams it is authorized to record, claims due highlights, uploads a vertical MP4 to a signed URL and
// reports completion; the server verifies the file before registering it as a finished job.
import { inspectMp4 } from "@/lib/mp4-inspect";

export async function hashToken(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
const MAX_ATTEMPTS = 3, CLAIM_MS = 15 * 60_000, MAX_BYTES = 80 * 1024 * 1024;

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
  if (body.action === "frame") { // visual game check from the recorder's buffer; never blocks capture
    const b = body as unknown as { monitor_id?: string; frame_at?: string; jpeg_base64?: string; unavailable?: string };
    if (!b.monitor_id || !b.frame_at || Number.isNaN(Date.parse(b.frame_at))) return Response.json({ error: "bad frame" }, { status: 400 });
    const { MAX_FRAME_BYTES, recordScene } = await import("@/server/live-vision.server");
    if (b.jpeg_base64 && b.jpeg_base64.length * 0.75 > MAX_FRAME_BYTES) return Response.json({ error: "frame too large" }, { status: 413 });
    return Response.json(await recordScene(db, uid, b.monitor_id, new Date(b.frame_at), b.jpeg_base64 ?? null, b.unavailable));
  }
  if (body.action === "claim") {
    const now = new Date().toISOString();
    const { data: due } = await db.from("live_highlights").select("id,monitor_id,start_at,end_at,peak_at,offset_s,attempts").eq("user_id", uid).eq("status", "awaiting_media")
      .lt("end_at", new Date(Date.now() - 5000).toISOString()).or(`claim_until.is.null,claim_until.lt.${now}`).order("start_at").limit(2);
    const out = [];
    for (const h of due ?? []) {
      if (h.attempts >= MAX_ATTEMPTS) { await db.from("live_highlights").update({ status: "failed", detail: "Превышено число попыток записи" }).eq("id", h.id); continue; }
      const claim = crypto.randomUUID(); const path = `${uid}/live/${h.id}.mp4`;
      const { data: ok } = await db.from("live_highlights").update({ status: "claimed", claim, claim_until: new Date(Date.now() + CLAIM_MS).toISOString(), attempts: h.attempts + 1, output_path: path })
        .eq("id", h.id).eq("status", "awaiting_media").select("id").maybeSingle();
      if (!ok) continue;
      const { data: up } = await db.storage.from("outputs").createSignedUploadUrl(path, { upsert: true });
      out.push({ ...h, claim, upload_url: up?.signedUrl });
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
    await db.from("live_highlights").update({ status: "done", job_id: job?.id ?? null, claim: null, detail: `MP4 ${info.video.width}×${info.video.height}, ${(info.durationS || durationHint || 0).toFixed(1)} с${source === "tab" ? " · из вкладки Chrome" : ""}` }).eq("id", h.id);
  return { job_id: job?.id };
}
