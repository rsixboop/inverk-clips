// Durable, step-wise job pipeline. Each call advances a job by at most one stage under a DB lease,
// so no request ever blocks on multi-minute provider work. Safe to call from UI polling or webhooks.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { generateResponse } from "@lovable.dev/ai-gateway";
import { buildEdit, getRender, probe, ProviderError, shotstackConfigured, submitRender } from "@/lib/shotstack";
import { inspectDirectVideo } from "@/lib/url-guard";

type DB = SupabaseClient<Database>;
type Job = Database["public"]["Tables"]["jobs"]["Row"];
export type Plan = {
  title: string; script: string; caption: string; hashtags: string[];
  clip_start: number; clip_length: number; media_url?: string; media_expires?: string; source_duration?: number | null;
  claims: { claim: string; source_url: string | null; status: "sourced" | "needs_verification" }[];
  selection_note: string; render_url?: string; render_submitted_at?: string;
};

const RENDER_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const backoff = (n: number) => Math.min(300, 10 * 2 ** n);

async function log(db: DB, job: Job, stage: string, message: string, level = "info", duration_ms?: number) {
  await db.from("job_events").insert({ job_id: job.id, user_id: job.user_id, stage, message, level, duration_ms: duration_ms ?? null });
}
async function patch(db: DB, job: Job, p: Partial<Job>) {
  const { error } = await db.from("jobs").update({ ...p, updated_at: new Date().toISOString() }).eq("id", job.id);
  if (error) throw new Error(error.message);
  Object.assign(job, p);
}
async function fail(db: DB, job: Job, stage: string, msg: string, status: "failed" | "blocked" = "failed") {
  await patch(db, job, { status, failed_stage: stage, error: msg, finished_at: status === "failed" ? new Date().toISOString() : null });
  await log(db, job, stage, msg, status === "blocked" ? "warn" : "error");
}

export async function processJob(db: DB, jobId: string, opts: { callbackBase?: string } = {}) {
  const now = new Date();
  const { data: leased } = await db.from("jobs")
    .update({ lock_until: new Date(now.getTime() + 90_000).toISOString() })
    .eq("id", jobId).in("status", ["queued", "running"]).lte("next_attempt_at", now.toISOString())
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
    .select("*").maybeSingle();
  if (!leased) return;
  const job = leased as Job;
  const t0 = Date.now();
  try {
    if (job.status === "queued") await patch(db, job, { status: "running" });
    await step(db, job, opts);
  } catch (e) {
    const err = e as Error;
    const retryable = e instanceof ProviderError ? e.retryable : false;
    if (retryable && job.attempts < MAX_ATTEMPTS) {
      const wait = backoff(job.attempts);
      await patch(db, job, { attempts: job.attempts + 1, next_attempt_at: new Date(Date.now() + wait * 1000).toISOString() });
      await log(db, job, job.stage, `${err.message} — повтор через ${wait} с (попытка ${job.attempts}/${MAX_ATTEMPTS})`, "warn");
    } else {
      await fail(db, job, job.stage, err.message);
    }
  } finally {
    await db.from("jobs").update({ lock_until: null }).eq("id", job.id);
    void t0;
  }
}

async function step(db: DB, job: Job, opts: { callbackBase?: string }) {
  const t = Date.now();
  const plan = (job.plan ?? {}) as Partial<Plan>;
  switch (job.stage) {
    case "validate": {
      if (!job.source_id) return fail(db, job, "validate",
        "Нужен исходный футаж: загрузите видео или дайте прямую MP4-ссылку. Автоматический поиск лицензированного футажа не подключён.", "blocked");
      const { data: src } = await db.from("sources").select("*").eq("id", job.source_id).single();
      if (!src) return fail(db, job, "validate", "Источник не найден");
      if (["youtube", "twitch"].includes(src.kind)) return fail(db, job, "validate",
        "Скачивание с YouTube/Twitch не поддерживается (нет официального API загрузки). Скачайте свою/разрешённую запись и загрузите файл.");
      if (src.kind === "channel") return fail(db, job, "validate", "Ссылка на канал — это источник для поиска, а не видео. Укажите конкретный MP4 или загрузите файл.");
      if (src.kind === "research_link") return fail(db, job, "validate", "Это ссылка на страницу, а не на видеофайл.");
      if (src.permission === "unknown") return fail(db, job, "validate", "Укажите права на использование источника (свой / лицензия / разрешение) на странице «Источники».", "blocked");
      if (!shotstackConfigured()) return fail(db, job, "validate", "Не подключено: рендерер Shotstack. Добавьте секрет SHOTSTACK_API_KEY в настройках проекта.", "blocked");
      let mediaUrl: string;
      if (src.kind === "upload") {
        const { data, error } = await db.storage.from("footage").createSignedUrl(src.storage_path!, 6 * 3600);
        if (error || !data) throw new Error("Не удалось подписать ссылку на загруженный файл");
        mediaUrl = data.signedUrl;
      } else {
        mediaUrl = (await inspectDirectVideo(src.url!)).url;
      }
      const duration = await probe(mediaUrl);
      if (!duration) return fail(db, job, "validate", "Рендерер не смог прочитать видео (probe без длительности). Проверьте файл.");
      await db.from("sources").update({ duration_s: duration }).eq("id", src.id);
      await patch(db, job, { stage: "plan", attempts: 0, plan: { ...plan, media_url: mediaUrl, media_expires: new Date(Date.now() + 6 * 3600e3).toISOString(), source_duration: duration } as any });
      return log(db, job, "validate", `Источник проверен: «${src.title || "видео"}», ${duration.toFixed(1)} с`, "info", Date.now() - t);
    }
    case "plan": {
      const p = await aiPlan(db, job, plan);
      await patch(db, job, { plan: { ...plan, ...p } as any, script: p.script, caption: `${p.caption}\n\n${p.hashtags.map((h) => "#" + h.replace(/^#/, "")).join(" ")}`,
        stage: "render_submit", attempts: 0, status: job.review_before_render ? "review" : "running" });
      return log(db, job, "plan", `Сценарий готов: «${p.title}». ${p.selection_note}`, "info", Date.now() - t);
    }
    case "render_submit": {
      if (job.render_id) { await patch(db, job, { stage: "render_wait" }); return; } // idempotent: never resubmit
      if (!plan.media_url || (plan.media_expires && new Date(plan.media_expires).getTime() < Date.now() + 30 * 60e3)) {
        await patch(db, job, { stage: "validate" });
        return log(db, job, "render_submit", "Ссылка на футаж устарела — перепроверяю источник");
      }
      const attempt = job.render_attempt + 1;
      // claim the submit slot atomically so concurrent ticks can't double-submit (double charge)
      const { data: claimed } = await db.from("jobs").update({ render_attempt: attempt }).eq("id", job.id).eq("render_attempt", job.render_attempt).is("render_id", null).select("id").maybeSingle();
      if (!claimed) return;
      job.render_attempt = attempt;
      const callbackUrl = opts.callbackBase ? await callbackFor(opts.callbackBase, job.id) : undefined;
      const edit = buildEdit({ videoUrl: plan.media_url, clipStart: plan.clip_start ?? 0, clipLength: plan.clip_length ?? job.target_seconds,
        audioMode: job.audio_mode as any, script: job.script ?? plan.script ?? "", language: job.language as any, callbackUrl });
      let id: string;
      try { id = await submitRender(edit); } catch (e) {
        if (e instanceof ProviderError && e.status === 0 && e.retryable)
          throw new ProviderError(`Неизвестный исход отправки рендера (${e.message}). Автоповтор отключён во избежание двойной оплаты — проверьте Shotstack и нажмите «Повторить шаг».`, 0, false);
        throw e;
      }
      await patch(db, job, { render_id: id, stage: "render_wait", attempts: 0, plan: { ...plan, render_submitted_at: new Date().toISOString() } as any });
      return log(db, job, "render_submit", `Рендер отправлен в Shotstack (id ${id}, попытка ${attempt})`, "info", Date.now() - t);
    }
    case "render_wait": {
      const r = await getRender(job.render_id!);
      if (r.status === "done" && r.url) {
        await patch(db, job, { stage: "finalize", plan: { ...plan, render_url: r.url } as any });
        return log(db, job, "render_wait", "Рендер завершён провайдером", "info");
      }
      if (r.status === "failed") return fail(db, job, "render_wait", `Shotstack: рендер не удался — ${r.error ?? "без описания"}`);
      if (plan.render_submitted_at && Date.now() - new Date(plan.render_submitted_at).getTime() > RENDER_TIMEOUT_MS)
        return fail(db, job, "render_wait", "Таймаут рендера (20 мин)");
      await patch(db, job, { next_attempt_at: new Date(Date.now() + 5000).toISOString() });
      if (job.attempts === 0) { await patch(db, job, { attempts: 0 }); }
      return;
    }
    case "finalize": {
      const res = await fetch(plan.render_url!, { signal: AbortSignal.timeout(50000) });
      if (!res.ok) throw new ProviderError(`Не удалось скачать результат: ${res.status}`, res.status, true);
      const buf = new Uint8Array(await res.arrayBuffer());
      const ftyp = new TextDecoder().decode(buf.slice(4, 8));
      if (buf.byteLength < 10_000 || ftyp !== "ftyp") return fail(db, job, "finalize", `Результат не похож на MP4 (размер ${buf.byteLength} байт, сигнатура «${ftyp}»)`);
      const path = `${job.user_id}/${job.id}/r${job.render_attempt}.mp4`;
      const { error } = await db.storage.from("outputs").upload(path, buf, { contentType: "video/mp4", upsert: true });
      if (error) throw new Error(`Сохранение MP4: ${error.message}`);
      await patch(db, job, { output_path: path, output_mime: "video/mp4", output_bytes: buf.byteLength, status: "succeeded", stage: "done", finished_at: new Date().toISOString(), error: null });
      return log(db, job, "finalize", `MP4 проверен и сохранён (${(buf.byteLength / 1048576).toFixed(1)} МБ, 1080×1920)`, "info", Date.now() - t);
    }
  }
}

async function aiPlan(db: DB, job: Job, plan: Partial<Plan>): Promise<Plan> {
  let niche = "";
  if (job.niche_id) { const { data } = await db.from("niches").select("name,description").eq("id", job.niche_id).single(); if (data) niche = `${data.name}: ${data.description}`; }
  const dur = plan.source_duration ?? job.target_seconds;
  const target = Math.min(job.target_seconds, Math.floor(dur));
  const lang = { en: "English", ru: "Russian", uk: "Ukrainian" }[job.language] ?? "English";
  const sys = `You plan short vertical videos. Rules: never invent facts; never present GTA VI gameplay or leaks as real; only state facts you are highly confident are publicly established, and mark each factual claim. If unsure, phrase as opinion/question or omit. You do NOT have the transcript or frames of the footage; choose the clip window by duration only and say so honestly. Return JSON only.`;
  const user = `Return JSON with keys: title (string), script (voiceover text in ${lang}, about ${Math.round(target * 2.3)} words, spoken only, no stage directions), caption (TikTok caption in ${lang}, <=150 chars), hashtags (array of 3-6 strings without #), clip_start (seconds, number), clip_length (seconds, number, ${Math.max(5, target - 2)}-${target}), claims (array of {claim, source_url (official/primary URL or null), status: "sourced"|"needs_verification"}), selection_note (Russian, one sentence explaining how the window was chosen).
Mode: ${job.mode}. Audio: ${job.audio_mode === "original" ? "original audio kept, script is only used for caption text" : "AI voiceover"}.
Niche: ${niche || "general"}. Footage duration: ${dur.toFixed(1)}s. Target length: ${target}s.
User request: ${job.prompt}`;
  const r = await generateResponse({ model: "openai/gpt-6-astra", instructions: sys, input: [{ role: "user", content: user + "\nReturn JSON." }], text: { format: { type: "json_object" } } } as any);
  const txt = extractText(r);
  let j: any;
  try { j = JSON.parse(txt); } catch { throw new Error("ИИ вернул некорректный план"); }
  const len = Math.max(3, Math.min(Number(j.clip_length) || target, target, dur));
  const start = Math.max(0, Math.min(Number(j.clip_start) || 0, dur - len));
  return { title: String(j.title ?? "Ролик"), script: String(j.script ?? ""), caption: String(j.caption ?? ""), hashtags: (j.hashtags ?? []).map(String).slice(0, 6),
    clip_start: start, clip_length: len, claims: Array.isArray(j.claims) ? j.claims.slice(0, 10) : [], selection_note: String(j.selection_note ?? "") } as Plan;
}

function extractText(r: any): string {
  if (typeof r?.output_text === "string") return r.output_text;
  for (const o of r?.output ?? []) for (const c of o?.content ?? []) if (c?.type === "output_text") return c.text;
  throw new Error("Пустой ответ ИИ");
}

export async function signJob(jobId: string) {
  const secret = process.env["WEBHOOK_SIGNING_SECRET"] ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(jobId));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function callbackFor(base: string, jobId: string) {
  return `${base}/api/public/shotstack-webhook?job=${jobId}&sig=${await signJob(jobId)}`;
}
