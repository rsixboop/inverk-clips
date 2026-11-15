// Durable, step-wise job pipeline. Each call advances a job by at most one stage under a FENCED lease:
// the lease stores a random token; every job write requires that token AND a live status
// (queued/running). Cancel/pause clear the token, so in-flight work from a cancelled or stale worker
// can never overwrite state, resurrect a job or publish an output.
// Paid submissions persist a "submitting" barrier first; a crash/timeout with unknown outcome is
// never auto-resubmitted (manual retry with explicit confirmation only).
import type { Database } from "@/integrations/supabase/types";
import { generateResponse } from "@lovable.dev/ai-gateway";
import { FAL, falConfigured, falSubmit, falPoll, providerMedia, scaleInput, captionInput, validMoments } from "@/lib/providers/fal";
import { atlasConfigured, atlasSubmit, atlasPoll, ATLAS_TTS, ATLAS_IMAGE, ttsInput, imageInput } from "@/lib/providers/atlas";
import { ProviderError } from "@/lib/providers/http";
import { tavilySearch, tavilyConfigured, type ResearchHit } from "@/lib/providers/tavily";

import { inspectDirectVideo } from "@/lib/url-guard";
import { fetchOutput } from "@/lib/output-fetch";
import { assertTikTokReady, inspectMp4 } from "@/lib/mp4-inspect";

export type Job = Database["public"]["Tables"]["jobs"]["Row"];
export type Src = Database["public"]["Tables"]["sources"]["Row"];
export type Candidate = { source_id: string; title: string; provider: string; kind: string; preview: string | null; duration: number | null; score: number; reason: string; selected: boolean; license: string };

export interface Store {
  lease(jobId: string, token: string, untilMs: number): Promise<Job | null>;
  update(job: Job, token: string, p: Partial<Job>): Promise<boolean>;
  release(jobId: string, token: string): Promise<void>;
  recordOrphan(jobId: string, field: "render_id" | "provider_project_id", id: string): Promise<void>;
  log(job: Job, stage: string, message: string, level?: string, durationMs?: number): Promise<void>;
  getSource(userId: string, id: string): Promise<Src | null>;
  library(userId: string): Promise<Src[]>;
  setSourceDuration(userId: string, id: string, d: number): Promise<void>;
  signFootage(userId: string, path: string): Promise<string>;
  uploadOutput(path: string, bytes: Uint8Array): Promise<void>;
  removeOutput(path: string): Promise<void>;
}
export type Deps = {
  ai: (instructions: string, user: string, images?: string[]) => Promise<any>;
  tavilyConfigured: () => boolean; tavilySearch: typeof tavilySearch;
  falConfigured: () => boolean; falSubmit: typeof falSubmit; falPoll: typeof falPoll;
  atlasConfigured: () => boolean; atlasSubmit: typeof atlasSubmit; atlasPoll: typeof atlasPoll;
  inspectDirectVideo: typeof inspectDirectVideo;
  fetchOutput: (url: string, route: string) => Promise<Uint8Array>;
  signJob: (id: string) => Promise<string>;
  now: () => number;
};

export const LEASE_MS = 120_000;
const RENDER_TIMEOUT_MS = 20 * 60e3;
const PROVIDER_POLL_MS = 15e3;
const MAX_ATTEMPTS = 4;
const backoff = (n: number) => Math.min(300, 15 * 2 ** n);
const LANG = { en: "English", ru: "Russian", uk: "Ukrainian" } as Record<string, string>;
export const AMBIGUOUS_MSG = (p: string) => `Неизвестный исход отправки в ${p}: запрос мог дойти до провайдера. Автоповтор отключён во избежание двойной оплаты. Проверьте кабинет ${p}; повтор возможен только вручную с подтверждением.`;

export class StaleLease extends Error { constructor() { super("stale lease"); } }

type Ctx = { store: Store; deps: Deps; job: Job; token: string; opts: { callbackBase?: string | undefined } };
async function patch(c: Ctx, p: Partial<Job>) {
  if (!(await c.store.update(c.job, c.token, p))) throw new StaleLease();
  Object.assign(c.job, p);
}
const log = (c: Ctx, stage: string, m: string, level = "info", d?: number) => c.store.log(c.job, stage, m, level, d);
async function fail(c: Ctx, stage: string, msg: string, status: "failed" | "blocked" = "failed") {
  await patch(c, { status, failed_stage: stage, error: msg, finished_at: status === "failed" ? new Date(c.deps.now()).toISOString() : null });
  await log(c, stage, msg, status === "blocked" ? "warn" : "error");
}
const P = (job: Job): any => job.plan ?? {};
const setPlan = (c: Ctx, add: Record<string, unknown>, extra: Partial<Job> = {}) => patch(c, { plan: { ...P(c.job), ...add } as any, ...extra });

export async function processJob(store: Store, deps: Deps, jobId: string, opts: { callbackBase?: string | undefined } = {}) {
  const token = crypto.randomUUID();
  const job = await store.lease(jobId, token, deps.now() + LEASE_MS);
  if (!job) return "not_leased" as const;
  const c: Ctx = { store, deps, job, token, opts };
  try {
    if (job.status === "queued") await patch(c, { status: "running" });
    if (job.workflow_version !== 2) await fail(c, job.stage, "Задача старого провайдера: автоматический повтор отключён. Готовые файлы сохранены; создайте новую задачу для fal.ai / Atlas Cloud.", "blocked");
    else if (deps.now() > new Date(job.deadline_at).getTime())
      await fail(c, job.stage, "Превышено максимальное время обработки задачи (3 ч). Нажмите «Повторить шаг», чтобы продолжить.");
    else await step(c);
    return "ok" as const;
  } catch (e) {
    if (e instanceof StaleLease) { await store.log(job, job.stage, "Результат шага отброшен: задача отменена/приостановлена или перехвачена другим обработчиком", "warn").catch(() => {}); return "stale" as const; }
    try { await onError(c, e); } catch (e2) { if (!(e2 instanceof StaleLease)) throw e2; return "stale" as const; }
    return "error" as const;
  } finally {
    await store.release(job.id, token);
  }
}

async function onError(c: Ctx, e: unknown) {
  const { job } = c;
  const err = e as Error;
  const pe = e instanceof ProviderError ? e : null;
  const safeToRepeat = (!job.stage.endsWith("_submit"));
  if (pe?.retryable && (!pe.ambiguous || safeToRepeat) && job.attempts < MAX_ATTEMPTS) {
    const wait = backoff(job.attempts);
    await patch(c, { attempts: job.attempts + 1, next_attempt_at: new Date(c.deps.now() + wait * 1000).toISOString() });
    await log(c, job.stage, `${err.message} — повтор через ${wait} с (попытка ${job.attempts}/${MAX_ATTEMPTS})`, "warn");
  } else await fail(c, job.stage, err.message, err.message.startsWith("Не подключено") ? "blocked" : "failed");
}

async function source(c: Ctx, id: string | null) { return id ? c.store.getSource(c.job.user_id, id) : null; }
async function mediaUrl(c: Ctx, s: Src): Promise<string> {
  if (s.kind === "upload") return c.store.signFootage(c.job.user_id, s.storage_path ?? "");
  if (["direct_url", "stock"].includes(s.kind) && s.url) return (await c.deps.inspectDirectVideo(s.url)).url;
  throw new Error(`Источник «${s.title}» нельзя использовать как футаж`);
}

type Task = { provider: "fal" | "atlas"; model: string; state: "submitting" | "submitted" | "done"; id?: string; submitted_at: number; result?: Record<string, any> };
async function submitTask(c: Ctx, key: string, provider: "fal" | "atlas", model: string, input: Record<string, unknown>, waitStage = `${key}_wait`) {
  const tasks = P(c.job).provider_tasks ?? {}, previous: Task | undefined = tasks[key];
  if (previous?.id) { await patch(c, { stage: waitStage }); return; }
  if (previous?.state === "submitting") throw new ProviderError(AMBIGUOUS_MSG(provider), 0, false);
  if (!(provider === "fal" ? c.deps.falConfigured() : c.deps.atlasConfigured())) return fail(c, c.job.stage, `Не подключено: ${provider === "fal" ? "FAL_KEY" : "ATLAS_CLOUD_API_KEY"}`, "blocked");
  const task: Task = { provider, model, state: "submitting", submitted_at: c.deps.now() };
  await setPlan(c, { provider_tasks: { ...tasks, [key]: task } }, { submit_state: "submitting", render_attempt: c.job.render_attempt + 1 });
  let id: string;
  try { id = await (provider === "fal" ? c.deps.falSubmit(model, input) : c.deps.atlasSubmit(model, input)); }
  catch (e) {
    if (!(e instanceof ProviderError) || e.ambiguous) throw new ProviderError(AMBIGUOUS_MSG(provider), 0, false, true);
    const reset = { ...tasks }; delete reset[key];
    await setPlan(c, { provider_tasks: reset }, { submit_state: null }); throw e;
  }
  try { await setPlan(c, { provider_tasks: { ...tasks, [key]: { ...task, state: "submitted", id } } }, { submit_state: "submitted", stage: waitStage, attempts: 0, next_attempt_at: new Date(c.deps.now() + PROVIDER_POLL_MS).toISOString() }); }
  catch (e) { if (e instanceof StaleLease) await c.store.recordOrphan(c.job.id, "provider_project_id", `${provider}:${model}:${id}`); throw e; }
  await log(c, c.job.stage, `${provider === "fal" ? "fal.ai" : "Atlas Cloud"}: запрос принят (${key})`);
}
async function pollTask(c: Ctx, key: string): Promise<Record<string, any> | null> {
  const tasks = P(c.job).provider_tasks ?? {}, task: Task | undefined = tasks[key];
  if (!task?.id) throw new Error("Нет ID запроса провайдера; автоматическая повторная отправка запрещена");
  if (task.state === "done" && task.result) return task.result;
  if (c.deps.now() - task.submitted_at > RENDER_TIMEOUT_MS) throw new Error("Таймаут операции провайдера (20 минут)");
  const r = await (task.provider === "fal" ? c.deps.falPoll(task.model, task.id) : c.deps.atlasPoll(task.model, task.id));
  if (r.state === "processing") { await patch(c, { next_attempt_at: new Date(c.deps.now() + PROVIDER_POLL_MS).toISOString() }); return null; }
  await setPlan(c, { provider_tasks: { ...tasks, [key]: { ...task, state: "done", result: r.result } } });
  return r.result;
}

async function step(c: Ctx) {
  const { job, deps } = c;
  const t = deps.now();
  const plan = P(job);
  switch (job.stage) {
    case "validate": {
      const src = await source(c, job.source_id);
      if (job.source_id && !src) return fail(c, "validate", "Источник не найден или принадлежит другому пользователю");
      if (job.route === "clip") {
        if (!src) return fail(c, "validate", "Для ИИ-нарезки загрузите видео или укажите прямой MP4");
        if (!["direct_url", "upload"].includes(src.kind)) return fail(c, "validate", "YouTube/Twitch: подтверждённый способ импорта без подписки не найден. Загрузите разрешённый видеофайл.", "blocked");
        if (src.permission === "unknown") return fail(c, "validate", "Укажите права на источник.", "blocked");
        await setPlan(c, { input_url: await mediaUrl(c, src) }, { stage: "metadata_submit", attempts: 0 });
        return log(c, "validate", "Источник принят: анализ речи и доступных кадров");
      }
      if (src) {
        if (["youtube", "twitch", "channel", "research_link"].includes(src.kind)) return fail(c, "validate", "Для сборки нужен разрешённый видеофайл. YouTube/Twitch пока не импортируются; загрузите MP4. Канал — это не видео.");
        if (src.permission === "unknown") return fail(c, "validate", "Укажите права на использование источника на странице «Источники».", "blocked");
      } else if (job.mode === "link") return fail(c, "validate", "Режим «По ссылке» требует источник");
      await patch(c, { stage: job.mode === "link" ? "discover" : "research", attempts: 0 });
      return log(c, "validate", src ? `Источник проверен: ${src.title}` : "Поиск разрешённых материалов в библиотеке");
    }
    case "research": {
      if (!deps.tavilyConfigured()) return fail(c, "research", "Не подключено: TAVILY_API_KEY — без веб-поиска факты в сценарии не будут подтверждены.", "blocked");
      const q = await deps.ai("You prepare search queries. Return JSON only.",
        `For this short-video request produce: search_query (English web search query for current factual info, <=12 words), stock_query (2-4 English words for generic stock B-roll that would genuinely fit; empty string if only gameplay/specific footage fits), needs_specific_footage (true if the topic needs specific footage such as game gameplay, a named person or product that generic stock cannot show).\nRequest: ${job.prompt}`);
      const hits = await deps.tavilySearch(String(q.search_query || job.prompt));
      await setPlan(c, { research: hits, search_query: q.search_query, stock_query: String(q.stock_query ?? ""), needs_specific_footage: !!q.needs_specific_footage }, { stage: "discover", attempts: 0 });
      return log(c, "research", `Веб-поиск: ${hits.length} источников по запросу «${q.search_query}»`, "info", deps.now() - t);
    }
    case "discover": {
      const pool: Src[] = [];
      const own = await source(c, job.source_id);
      if (own) pool.push(own);
      for (const s of await c.store.library(job.user_id)) if (!pool.some((p) => p.id === s.id)) pool.push(s);
      const notes: string[] = [];
      // Web research never implies licensed/downloadable media. Reuse permitted library first.
      if (!pool.length && !plan.needs_specific_footage && /иллюстрац|illustrat|сгенерир|generate.*image/i.test(job.prompt)) {
        await setPlan(c, { generated_illustration: true, image_prompt: `Clearly an illustration, not documentary footage. ${job.prompt}`, candidates: [{ source_id: "generated", title: "ИИ-иллюстрация", selected: true, duration: job.target_seconds, provider: "Atlas Cloud", license: "Generated illustration" }] }, { stage: "plan" });
        return;
      }
      if (!pool.length) return fail(c, "discover", `Подходящий лицензированный футаж не найден. ${notes.join(" ")} Добавьте разрешённое видео в «Источники».`, "blocked");
      const judged = await deps.ai("You judge whether footage can honestly illustrate a video. Generic stock (city, cars) is NOT game gameplay; never mark it relevant for gameplay-specific claims. Return JSON only.",
        `Request: ${job.prompt}\nNeeds specific footage: ${!!plan.needs_specific_footage}\nCandidates:\n${pool.map((s, i) => `${i}. [${s.provider}/${s.kind}] ${s.title} ${s.permission_note ? "(" + s.permission_note.slice(0, 80) + ")" : ""}`).join("\n")}\nReturn {items:[{i, score (0-1), reason (Russian, short)}]} for every candidate.`);
      const cands: Candidate[] = pool.map((s, i) => {
        const it = (judged.items ?? []).find((x: any) => Number(x.i) === i) ?? {};
        const score = Math.max(0, Math.min(1, Number(it.score) || 0));
        return { source_id: s.id, title: s.title, provider: s.provider, kind: s.kind, preview: s.preview_url, duration: s.duration_s ? Number(s.duration_s) : null, score, reason: String(it.reason ?? ""), selected: score >= 0.6 || s.id === job.source_id, license: s.license || s.permission };
      }).filter((x) => pool.find((s) => s.id === x.source_id)?.permission !== "unknown").sort((a, b) => b.score - a.score).slice(0, 12);
      const chosen = cands.filter((x) => x.selected);
      if (!chosen.length) {
        await setPlan(c, { candidates: cands, gap: `Нет релевантного лицензированного футажа${plan.needs_specific_footage ? " (нужен конкретный материал, например геймплей)" : ""}. Стоковые ролики не подменяют геймплей. Добавьте разрешённый источник или отметьте кандидатов вручную.` }, { stage: "plan", status: "review" });
        return log(c, "discover", "Пробел в футаже: релевантных кандидатов нет — нужна ваша проверка", "warn");
      }
      await setPlan(c, { candidates: cands, gap: null, discover_notes: notes }, { stage: "plan", attempts: 0, ...(job.approve_sources ? { status: "review" } : {}) });
      return log(c, "discover", `Найдено ${cands.length} кандидатов, выбрано ${chosen.length}. ${notes.join(" ")}`, "info", deps.now() - t);
    }
    case "plan": {
      const chosen = ((plan.candidates ?? []) as Candidate[]).filter((x) => x.selected);
      if (!chosen.length) return fail(c, "plan", "Не выбрано ни одного клипа", "blocked");
      const hits = (plan.research ?? []) as ResearchHit[];
      const T = job.target_seconds;
      const j = await deps.ai(`You write short vertical-video scripts. Use ONLY facts supported by the numbered search results; cite them by number. If results don't support a fact, don't state it. Never present GTA VI gameplay/leaks as real. Return JSON only.`,
        `Language: ${LANG[job.language]}. Target ${T}s; voiceover must be about ${Math.round(T * 2.4)} words (spoken only, no stage directions).
Request: ${job.prompt}
Search results:\n${hits.map((h, i) => `[${i}] ${h.title} — ${h.url}\n${h.snippet}`).join("\n") || "(none — avoid factual claims)"}
Clips in order: ${chosen.map((x, i) => `${i}:${x.title}(${x.duration ?? "?"}s)`).join("; ")}
Return {title, script, caption (<=150 chars), hashtags[3-6], claims:[{claim, ref (result number)}], order: [clip indices in the best order]}.`);
      const claims = (Array.isArray(j.claims) ? j.claims : []).map((x: any) => ({ claim: String(x.claim), hit: hits[Number(x.ref)] })).filter((x: any) => x.hit)
        .map((x: any) => ({ claim: x.claim, source_url: x.hit.url, source_title: x.hit.title, status: "sourced" }));
      const order: number[] = (Array.isArray(j.order) ? j.order : []).map(Number).filter((n: number) => n >= 0 && n < chosen.length);
      const seq = [...new Set([...order, ...chosen.map((_, i) => i)])].flatMap((i) => chosen[i] ? [chosen[i]] : []);
      const segLen = Math.max(3, T / seq.length);
      const timeline = seq.map((x) => ({ source_id: x.source_id, title: x.title, trim: 0, length: x.duration ? Math.min(segLen, x.duration) : segLen }));
      const hashtags = (j.hashtags ?? []).map((h: any) => "#" + String(h).replace(/^#/, "")).join(" ");
      await setPlan(c, { title: String(j.title ?? "Ролик"), claims, timeline, selection_note: "Ручная сборка: клипы выбраны по релевантности описания, нарезка по равным отрезкам (не анализ содержания кадров)." },
        { script: String(j.script ?? ""), caption: `${j.caption ?? ""}\n\n${hashtags}`, stage: plan.generated_illustration ? "image_submit" : job.audio_mode === "voiceover" ? "tts_submit" : "render_submit", attempts: 0, status: job.review_before_render ? "review" : "running" });
      return log(c, "plan", `Сценарий: «${j.title}», ${claims.length} фактов со ссылками, ${timeline.length} клипов`, "info", deps.now() - t);
    }
    case "metadata_submit": return submitTask(c, "metadata", "fal", FAL.metadata, { media_url: plan.input_url, extract_frames: true });
    case "metadata_wait": {
      const r = await pollTask(c, "metadata"); if (!r) return;
      const m = r["media"];
      if (!m || !Number.isFinite(m.duration) || m.duration <= 0) throw new Error("Не удалось определить длительность источника");
      if (m.duration > 1800) return fail(c, job.stage, "Для экономичной нарезки загрузите видео до 30 минут", "blocked");
      await setPlan(c, { input_meta: m }, { stage: "transcript_submit" }); return;
    }
    case "transcript_submit": return submitTask(c, "transcript", "fal", FAL.whisper, { audio_url: plan.input_url, task: "transcribe", chunk_level: "word", diarize: false });
    case "transcript_wait": {
      const r = await pollTask(c, "transcript"); if (!r) return;
      if (!Array.isArray(r["chunks"]) || !r["text"]) return fail(c, job.stage, "Речь не распознана. Используйте сборку с озвучкой для немого видео.", "blocked");
      await setPlan(c, { transcript: r["text"], words: r["chunks"] }, { stage: "moment_select" }); return;
    }
    case "moment_select": {
      const frames = [plan.input_meta?.start_frame_url, plan.input_meta?.end_frame_url].filter((u) => typeof u === "string").map(providerMedia);
      const j = await deps.ai("Select coherent moments matching the request using timestamped transcript. Never invent dialogue. Return JSON only.",
        `Request: ${job.prompt}\nDuration: ${plan.input_meta.duration}s, target ${job.target_seconds}s.\nWords: ${JSON.stringify(plan.words).slice(0, 70000)}\nReturn {moments:[{title,start,durationS,transcript,reason}],caption}. Up to 5 candidates, start and durationS in seconds; complete thoughts only.`, frames);
      const moments = validMoments(j.moments, plan.input_meta.duration, job.target_seconds);
      if (!moments.length) throw new Error("Не найден подходящий момент по содержанию");
      const first = moments[0]; if (!first) return;
      await setPlan(c, { moments, chosen_clip: 0, title: first.title, timeline: [{ source_id: job.source_id, trim: first.start, length: first.durationS }], selection_note: frames.length ? "Речь с таймкодами + первый/последний кадры; не полный анализ сцен. Кадрирование по центру." : "Речь с таймкодами; кадрирование по центру." },
        { script: first.transcript, caption: String(j.caption ?? first.title), stage: job.audio_mode === "voiceover" ? "tts_submit" : "render_submit", status: job.review_before_render ? "review" : "running" }); return;
    }
    case "image_submit": return submitTask(c, "image", "atlas", ATLAS_IMAGE, imageInput(plan.image_prompt));
    case "image_wait": {
      const r = await pollTask(c, "image"); if (!r) return;
      await setPlan(c, { image_url: providerMedia(r["url"]) }, { stage: job.audio_mode === "voiceover" ? "tts_submit" : "render_submit" }); return;
    }
    case "tts_submit": return submitTask(c, "tts", "atlas", ATLAS_TTS, ttsInput(job.script ?? ""));
    case "tts_wait": {
      const r = await pollTask(c, "tts"); if (!r) return;
      await setPlan(c, { audio_url: providerMedia(r["url"]) }, { stage: "audio_metadata_submit" }); return;
    }
    case "audio_metadata_submit": return submitTask(c, "audio_metadata", "fal", FAL.metadata, { media_url: plan.audio_url });
    case "audio_metadata_wait": {
      const r = await pollTask(c, "audio_metadata"); if (!r) return;
      const duration = Number(r["media"]?.duration);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error("Недопустимая длительность озвучки");
      await setPlan(c, { speech_duration: duration }, { stage: "render_submit" }); return;
    }
    case "render_submit": {
      if (!deps.falConfigured()) return fail(c, job.stage, "Не подключено: FAL_KEY — план сохранён", "blocked");
      const index = Number(plan.trim_index ?? 0), segments = plan.timeline ?? [];
      if (plan.generated_illustration) {
        if (!plan.audio_url) return fail(c, job.stage, "Для иллюстрации включите ИИ-озвучку", "blocked");
        await patch(c, { stage: "compose_submit" }); return;
      }
      const seg = segments[index];
      if (!seg) { await patch(c, { stage: "compose_submit" }); return; }
      const src = await source(c, seg.source_id);
      if (!src || src.permission === "unknown") return fail(c, job.stage, "Источник недоступен или права не подтверждены", "blocked");
      await submitTask(c, `trim${index}`, "fal", FAL.trim, { video_url: await mediaUrl(c, src), start_time: seg.trim, duration: seg.length }, "render_wait"); return;
    }
    case "render_wait": {
      const index = Number(plan.trim_index ?? 0), r = await pollTask(c, `trim${index}`); if (!r) return;
      await setPlan(c, { trimmed: [...(plan.trimmed ?? []), { url: providerMedia(r["video"]?.url), duration: Number(r["trimmed_duration"]) }], trim_index: index + 1 }, { stage: "render_submit" }); return;
    }
    case "compose_submit": {
      const duration = Number(plan.speech_duration ?? (plan.trimmed ?? []).reduce((n: number, s: any) => n + s.duration, 0));
      if (!duration || duration > 120) throw new Error("Недопустимая длина сборки");
      const keys: { url: string; timestamp: number; duration: number }[] = [];
      if (plan.image_url) keys.push({ url: plan.image_url, timestamp: 0, duration: duration * 1000 });
      else {
        const clips = plan.trimmed ?? []; if (!clips.length) throw new Error("Нет футажа");
        let t = 0, n = 0;
        // Repeat actual trimmed media only when speech runs longer; never a black tail.
        while (t < duration && n < 100) {
          const clip = clips[n % clips.length]; const len = Math.min(Number(clip.duration), duration - t);
          if (!(len > 0)) throw new Error("Клип без длительности");
          keys.push({ url: clip.url, timestamp: Math.round(t * 1000), duration: Math.round(len * 1000) }); t += len; n++;
        }
        if (t < duration) throw new Error("Недостаточно футажа для озвучки");
      }
      const tracks: any[] = [{ id: "visual", type: plan.image_url ? "image" : "video", keyframes: keys }];
      if (plan.audio_url) tracks.push({ id: "narration", type: "audio", keyframes: [{ url: plan.audio_url, timestamp: 0, duration: duration * 1000 }] });
      await submitTask(c, "compose", "fal", FAL.compose, { tracks }); return;
    }
    case "compose_wait": {
      const r = await pollTask(c, "compose"); if (!r) return;
      await setPlan(c, { composed_url: providerMedia(r["video_url"]) }, { stage: "scale_submit" }); return;
    }
    case "scale_submit": return submitTask(c, "scale", "fal", FAL.scale, scaleInput(plan.composed_url));
    case "scale_wait": {
      const r = await pollTask(c, "scale"); if (!r) return;
      await setPlan(c, { vertical_url: providerMedia(r["video"]?.url) }, { stage: "captions_submit" }); return;
    }
    case "captions_submit": return submitTask(c, "captions", "fal", FAL.captions, captionInput(plan.vertical_url, job.language));
    case "captions_wait": {
      const r = await pollTask(c, "captions"); if (!r) return;
      if (!(Number(r["subtitle_count"]) > 0)) throw new Error("Провайдер не создал субтитры");
      await setPlan(c, { render_url: providerMedia(r["video"]?.url), subtitle_count: r["subtitle_count"] }, { stage: "finalize" }); return;
    }
    case "finalize": {
      const url: string | undefined = plan.render_url;
      if (!url) return fail(c, "finalize", "Нет ссылки на результат провайдера");
      const buf = await deps.fetchOutput(url, job.route);
      let meta;
      try { meta = inspectMp4(buf); assertTikTokReady(meta, true); }
      catch (e) { return fail(c, "finalize", `Результат не прошёл проверку MP4: ${(e as Error).message}`); }
      const path = `${job.user_id}/${job.id}/r${job.render_attempt}.mp4`;
      await c.store.uploadOutput(path, buf);
      try {
        await patch(c, { output_path: path, output_mime: "video/mp4", output_bytes: buf.byteLength, status: "succeeded", stage: "done", finished_at: new Date(deps.now()).toISOString(), error: null,
          plan: { ...plan, output_meta: meta } as any });
      } catch (e) { if (e instanceof StaleLease) await c.store.removeOutput(path).catch(() => {}); throw e; }
      return log(c, "finalize", `MP4 проверен: H.264 ${meta.video?.width}×${meta.video?.height} + AAC, ${meta.durationS?.toFixed(1) ?? "?"} с, ${(buf.byteLength / 1048576).toFixed(1)} МБ`, "info", deps.now() - t);
    }
  }
}

async function ai(instructions: string, user: string, images: string[] = []): Promise<any> {
  const r: any = await generateResponse({ model: "openai/gpt-6-astra", instructions, input: [{ role: "user", content: images.length ? [{ type: "input_text", text: user + "\nReturn JSON." }, ...images.map((url) => ({ type: "input_image", image_url: url }))] : user + "\nReturn JSON." }], text: { format: { type: "json_object" } } } as any);
  let txt: string | undefined = r?.output_text;
  if (!txt) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") txt = x.text;
  if (!txt) throw new Error("Пустой ответ ИИ");
  try { return JSON.parse(txt); } catch { throw new Error("ИИ вернул некорректный JSON"); }
}

export async function signJob(jobId: string) {
  const secret = process.env["WEBHOOK_SIGNING_SECRET"] ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(jobId));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const realDeps = (): Deps => ({
  ai, tavilyConfigured, tavilySearch, falConfigured, falSubmit, falPoll, atlasConfigured, atlasSubmit, atlasPoll,
  inspectDirectVideo, fetchOutput: (u, r) => fetchOutput(u, r), signJob, now: () => Date.now(),
});

/** Entry point for server code: admin client, one bounded stage. */
export async function runJobStage(jobId: string, opts: { callbackBase?: string | undefined } = {}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { supabaseStore } = await import("./pipeline-store.server");
  return processJob(supabaseStore(supabaseAdmin), realDeps(), jobId, opts);
}
