// Folder-import protocol for the user's own recorder: it reports finalized local recordings (read-only),
// asks whether it may render one candidate, uploads the candidate's audio for transcription (fal whisper)
// and the rendered 9:16 MP4; the server verifies the file and registers one Library job per candidate.
import { detectRuEn, mayRenderNext, wordsToCues, type Cue } from "@/lib/local-captions";
import { inspectMp4 } from "@/lib/mp4-inspect";

type Db = (typeof import("@/integrations/supabase/client.server"))["supabaseAdmin"];
const S = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const MAX_MP4 = 120 * 1024 * 1024;

export async function handleFolder(db: Db, uid: string, body: any): Promise<Response | null> {
  const a = body?.action as string;
  if (a === "folder_index") {
    const files = Array.isArray(body.files) ? body.files.slice(0, 400) : [];
    const rows = files.filter((f: any) => typeof f?.rel_path === "string").map((f: any) => ({ user_id: uid, channel: S(f.channel, 80), rel_path: S(f.rel_path, 300), session: S(f.session, 40), file_name: S(f.file_name, 120),
      size_bytes: Number(f.size_bytes) || null, duration_s: Number.isFinite(f.duration_s) ? f.duration_s : null, start_at: f.start_at && !Number.isNaN(Date.parse(f.start_at)) ? f.start_at : null,
      aligned: f.aligned === true, status: S(f.status, 20), detail: f.detail ? S(f.detail, 200) : null, updated_at: new Date().toISOString() }));
    if (rows.length) { const { error } = await db.from("local_footage").upsert(rows, { onConflict: "user_id,rel_path" }); if (error) return Response.json({ error: error.message }, { status: 500 }); }
    return Response.json({ ok: true, n: rows.length });
  }
  if (a === "folder_next") {
    const { data: cands } = await db.from("local_candidates").select("status,review,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(5);
    const gate = mayRenderNext(cands ?? []);
    // Chat spikes the recorder may correlate when its local wall clock is verified.
    const { data: mons } = await db.from("live_monitors").select("id,channel_title,input,channel_id").eq("user_id", uid);
    const { data: hl } = await db.from("live_highlights").select("monitor_id,start_at,end_at,peak_at,score").eq("user_id", uid).gte("start_at", new Date(Date.now() - 7 * 86400_000).toISOString()).order("score", { ascending: false }).limit(200);
    const { data: used } = await db.from("local_candidates").select("window_info").eq("user_id", uid).limit(200);
    return Response.json({ render: gate.ok, why: gate.why, monitors: mons ?? [], highlights: hl ?? [], used: (used ?? []).map((u) => u.window_info) });
  }
  if (a === "candidate_create") {
    const { data: cands } = await db.from("local_candidates").select("status,review,created_at").eq("user_id", uid).order("created_at", { ascending: false }).limit(5);
    const gate = mayRenderNext(cands ?? []); if (!gate.ok) return Response.json({ error: gate.why }, { status: 409 });
    const segs = Array.isArray(body.segments) ? body.segments.slice(0, 6).map((s: any) => ({ file: S(s.file, 300), from_s: Number(s.from_s), to_s: Number(s.to_s) })) : [];
    if (!segs.length || segs.some((s: any) => !(s.to_s > s.from_s))) return Response.json({ error: "bad segments" }, { status: 400 });
    const { data: row, error } = await db.from("local_candidates").insert({ user_id: uid, channel: S(body.channel, 80), status: "transcribing", segments: segs, window_info: body.window_info ?? {}, score: Number(body.score) || null, reason: S(body.reason, 300) }).select("id").single();
    if (error || !row) return Response.json({ error: error?.message }, { status: 500 });
    const audio = await db.storage.from("outputs").createSignedUploadUrl(`${uid}/local/${row.id}.m4a`, { upsert: true });
    const video = await db.storage.from("outputs").createSignedUploadUrl(`${uid}/local/${row.id}.mp4`, { upsert: true });
    return Response.json({ id: row.id, audio_upload_url: audio.data?.signedUrl, video_upload_url: video.data?.signedUrl });
  }
  const id = typeof body?.id === "string" ? body.id : "";
  const { data: c } = id ? await db.from("local_candidates").select("*").eq("id", id).eq("user_id", uid).maybeSingle() : { data: null };
  if (!c && a?.startsWith("candidate_")) return Response.json({ error: "unknown candidate" }, { status: 404 });
  if (a === "candidate_transcribe" && c) {
    if (c.captions) return Response.json({ state: "done", captions: c.captions, note: c.caption_note });
    const { FAL, falPoll, falSubmit } = await import("@/lib/providers/fal");
    try {
      if (!c.whisper_request) {
        const signed = await db.storage.from("outputs").createSignedUrl(`${uid}/local/${c.id}.m4a`, 3600);
        if (signed.error) throw new Error("аудио не загружено");
        const rid = await falSubmit(FAL.whisper, { audio_url: signed.data.signedUrl, task: "transcribe", chunk_level: "word", diarize: false });
        await db.from("local_candidates").update({ whisper_request: rid, updated_at: new Date().toISOString() }).eq("id", c.id);
        return Response.json({ state: "pending" });
      }
      const r = await falPoll(FAL.whisper, c.whisper_request);
      if (r.state !== "done") return Response.json({ state: "pending" });
      const words = (r.result["chunks"] ?? []).flatMap((x: any) => typeof x.text === "string" && x.timestamp?.length === 2 && x.timestamp.every(Number.isFinite) ? [{ word: x.text, start: x.timestamp[0], end: x.timestamp[1] }] : []);
      const cues = wordsToCues(words); const lang = detectRuEn(cues.map((q) => q.text).join(" "));
      const note = cues.length ? await translate(cues, lang) : "речи не распознано — без субтитров";
      await db.from("local_candidates").update({ captions: cues as any, caption_note: note, updated_at: new Date().toISOString() }).eq("id", c.id);
      return Response.json({ state: "done", captions: cues, note });
    } catch (e) {
      const note = `субтитры недоступны: ${S((e as Error).message, 160)}`;
      await db.from("local_candidates").update({ captions: [], caption_note: note }).eq("id", c.id);
      return Response.json({ state: "done", captions: [], note });
    }
  }
  if (a === "candidate_progress" && c) { await db.from("local_candidates").update({ status: S(body.status, 20) || c.status, detail: body.detail ? S(body.detail, 300) : c.detail, updated_at: new Date().toISOString() }).eq("id", c.id); return Response.json({ ok: true }); }
  if (a === "candidate_fail" && c) { await db.from("local_candidates").update({ status: "failed", detail: S(body.error, 300) }).eq("id", c.id); return Response.json({ ok: true }); }
  if (a === "candidate_complete" && c) {
    const path = `${uid}/local/${c.id}.mp4`;
    const { data: file } = await db.storage.from("outputs").download(path);
    if (!file || file.size > MAX_MP4) return Response.json({ error: "upload missing/too large" }, { status: 400 });
    let info; try { info = inspectMp4(new Uint8Array(await file.arrayBuffer())); if (!info.video || !info.audio) throw new Error("нужны видео и оригинальный звук"); if (info.video.height <= info.video.width) throw new Error("не вертикальное"); }
    catch (e) { await db.from("local_candidates").update({ status: "failed", detail: `Неверный MP4: ${(e as Error).message}` }).eq("id", c.id); return Response.json({ error: "invalid mp4" }, { status: 400 }); }
    const segs = c.segments as { file: string; from_s: number; to_s: number }[];
    const ranges = segs.map((s) => `${s.file} ${s.from_s.toFixed(1)}–${s.to_s.toFixed(1)} с`).join(" + ");
    const dur = segs.reduce((t, s) => t + s.to_s - s.from_s, 0);
    const { data: job } = await db.from("jobs").upsert({ user_id: uid, idempotency_key: `local:${c.id}`, mode: "link", route: "live", audio_mode: "original", status: "completed", stage: "done",
      prompt: `Кандидат из папки · ${c.channel} · ${ranges}`, target_seconds: Math.min(90, Math.max(10, Math.round(dur))), output_path: path, output_mime: "video/mp4", output_bytes: file.size,
      finished_at: new Date().toISOString(), workflow_version: 2, plan: { title: `Кандидат · ${c.channel}`, local: { candidate_id: c.id, segments: segs, reason: c.reason, captions: c.caption_note } } }, { onConflict: "user_id,idempotency_key" }).select("id").single();
    if (!job) return Response.json({ error: "job registration failed" }, { status: 502 });
    const { enqueueClipAnalysis } = await import("./clip-analysis.server");
    await enqueueClipAnalysis(db, uid, job.id, path);
    await db.from("local_candidates").update({ status: "done", output_path: path, job_id: job?.id ?? null, detail: `MP4 ${info.video.width}×${info.video.height}, ${dur.toFixed(1)} с`, updated_at: new Date().toISOString() }).eq("id", c.id);
    return Response.json({ ok: true, job_id: job?.id });
  }
  return null;
}

async function translate(cues: Cue[], lang: "ru" | "en"): Promise<string> {
  const target = lang === "ru" ? "English" : "Russian";
  try {
    const { generateResponse } = await import("@lovable.dev/ai-gateway");
    const r: any = await generateResponse({ model: "openai/gpt-6.1-sol", instructions: `Translate each caption line to ${target}. Keep slang short and natural, no additions. JSON {"lines":[string]} same count and order.`,
      input: [{ role: "user", content: JSON.stringify(cues.map((q) => q.text)) }], text: { format: { type: "json_object" } } } as any);
    let out: string | undefined = r?.output_text; if (!out) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") out = x.text;
    const lines: unknown = JSON.parse(out ?? "{}").lines;
    if (!Array.isArray(lines) || lines.length !== cues.length) return `${lang.toUpperCase()} субтитры; перевод не получен`;
    cues.forEach((q, i) => { q.alt = String(lines[i] ?? "").slice(0, 80); });
    return `${lang.toUpperCase()} + ${lang === "ru" ? "EN" : "RU"} перевод`;
  } catch { return `${lang.toUpperCase()} субтитры; перевод недоступен`; }
}
