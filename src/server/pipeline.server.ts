// Durable, step-wise job pipeline. Each call advances a job by at most one stage under a FENCED lease:
// the lease stores a random token; every job write requires that token AND a live status
// (queued/running). Cancel/pause clear the token, so in-flight work from a cancelled or stale worker
// can never overwrite state, resurrect a job or publish an output.
// Paid submissions persist a "submitting" barrier first; a crash/timeout with unknown outcome is
// never auto-resubmitted (manual retry with explicit confirmation only).
import type { Database } from "@/integrations/supabase/types";
import { generateResponse } from "@lovable.dev/ai-gateway";
import { buildEdit, getRender, probe, shotstackConfigured, submitRender, type Segment } from "@/lib/shotstack";
import { ProviderError } from "@/lib/providers/http";
import { tavilySearch, tavilyConfigured, type ResearchHit } from "@/lib/providers/tavily";
import { pexelsConfigured, pexelsSearch } from "@/lib/providers/pexels";
import { buildSubmit, vizardConfigured, vizardQuery, vizardSubmit, type VizardClip } from "@/lib/providers/vizard";
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
  upsertStock(userId: string, row: Partial<Src> & { external_id: string }): Promise<Src | null>;
  setSourceDuration(userId: string, id: string, d: number): Promise<void>;
  signFootage(userId: string, path: string): Promise<string>;
  uploadOutput(path: string, bytes: Uint8Array): Promise<void>;
  removeOutput(path: string): Promise<void>;
}
export type Deps = {
  ai: (instructions: string, user: string) => Promise<any>;
  tavilyConfigured: () => boolean; tavilySearch: typeof tavilySearch;
  pexelsConfigured: () => boolean; pexelsSearch: typeof pexelsSearch;
  shotstackConfigured: () => boolean; submitRender: typeof submitRender; getRender: typeof getRender; probe: typeof probe;
  vizardConfigured: () => boolean; vizardSubmit: typeof vizardSubmit; vizardQuery: typeof vizardQuery;
  inspectDirectVideo: typeof inspectDirectVideo;
  fetchOutput: (url: string, route: string) => Promise<Uint8Array>;
  signJob: (id: string) => Promise<string>;
  now: () => number;
};

export const LEASE_MS = 120_000;
const RENDER_TIMEOUT_MS = 20 * 60e3;
const VIZARD_TIMEOUT_MS = 120 * 60e3;
const VIZARD_POLL_MS = 30e3;
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
    if (deps.now() > new Date(job.deadline_at).getTime() && !["render_wait", "vizard_wait"].includes(job.stage))
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
  const safeToRepeat = ["validate", "research", "discover", "plan", "render_wait", "vizard_wait", "vizard_select", "finalize"].includes(job.stage);
  if (pe?.retryable && (!pe.ambiguous || safeToRepeat) && job.attempts < MAX_ATTEMPTS) {
    const wait = backoff(job.attempts);
    await patch(c, { attempts: job.attempts + 1, next_attempt_at: new Date(c.deps.now() + wait * 1000).toISOString() });
    await log(c, job.stage, `${err.message} — повтор через ${wait} с (попытка ${job.attempts}/${MAX_ATTEMPTS})`, "warn");
  } else await fail(c, job.stage, err.message, err.message.startsWith("Не подключено") ? "blocked" : "failed");
}

async function source(c: Ctx, id: string | null) { return id ? c.store.getSource(c.job.user_id, id) : null; }
async function mediaUrl(c: Ctx, s: Src): Promise<string> {
  if (s.kind === "upload") return c.store.signFootage(c.job.user_id, s.storage_path ?? "");
  if (s.kind === "direct_url") return (await c.deps.inspectDirectVideo(s.url!)).url;
  if (s.kind === "stock" && s.provider === "pexels" && /^https:\/\/([a-z0-9-]+\.)*pexels\.com\//i.test(s.url ?? "")) return s.url!;
  throw new Error(`Источник «${s.title}» нельзя использовать как футаж`);
}

/** Paid submission with a persisted barrier written BEFORE the provider call. */
async function guardedSubmit(c: Ctx, provider: string, field: "render_id" | "provider_project_id", call: () => Promise<string>) {
  if (c.job.submit_state === "submitting") throw new ProviderError(AMBIGUOUS_MSG(provider), 0, false);
  await patch(c, { submit_state: "submitting", render_attempt: c.job.render_attempt + 1 }); // fenced: fails if cancelled → no call
  let id: string;
  try { id = await call(); }
  catch (e) {
    if (e instanceof ProviderError && e.ambiguous) throw new ProviderError(`${AMBIGUOUS_MSG(provider)} (${e.message})`, 0, false); // barrier stays
    await patch(c, { submit_state: null }); // definite rejection: nothing was created
    throw e;
  }
  try { await patch(c, { [field]: id, submit_state: "submitted" } as Partial<Job>); }
  catch (e) { if (e instanceof StaleLease) await c.store.recordOrphan(c.job.id, field, id); throw e; } // keep id for reconciliation, never use result
  return id;
}

async function step(c: Ctx) {
  const { job, deps } = c;
  const t = deps.now();
  const plan = P(job);
  switch (job.stage) {
    case "validate": {
      const src = await source(c, job.source_id);
      if (job.source_id && !src) return fail(c, "validate", "Источник не найден или принадлежит другому пользователю");
      if (job.route === "vizard") {
        if (!src) return fail(c, "validate", "Для ИИ-нарезки нужна ссылка на видео или загруженный файл");
        if (!["youtube", "twitch", "direct_url", "upload"].includes(src.kind)) return fail(c, "validate", "Этот тип источника Vizard не принимает. Нужна ссылка на конкретное видео (YouTube, запись Twitch, прямой MP4) или файл.");
        if (src.permission === "unknown") return fail(c, "validate", "Укажите права на использование источника на странице «Источники».", "blocked");
        if (!deps.vizardConfigured()) return fail(c, "validate", "Не подключено: VIZARD_API_KEY (ИИ-нарезка по ссылке). Добавьте секрет в настройках проекта.", "blocked");
        await patch(c, { stage: "vizard_submit", attempts: 0 });
        return log(c, "validate", `Источник принят для ИИ-нарезки: ${src.title}`);
      }
      if (src) {
        if (["youtube", "twitch", "channel", "research_link"].includes(src.kind)) return fail(c, "validate", "Для сборки нужен видеофайл. YouTube/Twitch — выберите маршрут «ИИ-нарезка (Vizard)». Канал — это не видео.");
        if (src.permission === "unknown") return fail(c, "validate", "Укажите права на использование источника на странице «Источники».", "blocked");
      } else if (job.mode === "link") return fail(c, "validate", "Режим «По ссылке» требует источник");
      await patch(c, { stage: job.mode === "link" ? "discover" : "research", attempts: 0 });
      return log(c, "validate", src ? `Источник проверен: ${src.title}` : "Без исходника — футаж будет найден автоматически");
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
      if (job.mode !== "link" && plan.stock_query) {
        if (!deps.pexelsConfigured()) notes.push("Pexels не подключён (PEXELS_API_KEY) — стоковый поиск пропущен.");
        else for (const s of await deps.pexelsSearch(plan.stock_query)) {
          const row = await c.store.upsertStock(job.user_id, { external_id: s.externalId, url: s.fileUrl, preview_url: s.preview, title: s.title || `Pexels ${s.externalId}`, mime: "video/mp4", duration_s: s.duration,
            permission: "licensed", license: "Pexels License (free use, attribution appreciated)", attribution: `${s.author} — ${s.pageUrl}`, permission_note: s.pageUrl });
          if (row && !pool.some((p) => p.id === row.id)) pool.push(row);
        }
      }
      if (!pool.length) return fail(c, "discover", `Подходящий лицензированный футаж не найден. ${notes.join(" ")} Добавьте разрешённое видео в «Источники».`, "blocked");
      const judged = await deps.ai("You judge whether footage can honestly illustrate a video. Generic stock (city, cars) is NOT game gameplay; never mark it relevant for gameplay-specific claims. Return JSON only.",
        `Request: ${job.prompt}\nNeeds specific footage: ${!!plan.needs_specific_footage}\nCandidates:\n${pool.map((s, i) => `${i}. [${s.provider}/${s.kind}] ${s.title} ${s.permission_note ? "(" + s.permission_note.slice(0, 80) + ")" : ""}`).join("\n")}\nReturn {items:[{i, score (0-1), reason (Russian, short)}]} for every candidate.`);
      const cands: Candidate[] = pool.map((s, i) => {
        const it = (judged.items ?? []).find((x: any) => Number(x.i) === i) ?? {};
        const score = Math.max(0, Math.min(1, Number(it.score) || 0));
        return { source_id: s.id, title: s.title, provider: s.provider, kind: s.kind, preview: s.preview_url, duration: s.duration_s ? Number(s.duration_s) : null, score, reason: String(it.reason ?? ""), selected: score >= 0.6 || s.id === job.source_id, license: s.license || s.permission };
      }).sort((a, b) => b.score - a.score).slice(0, 12);
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
      const seq = [...new Set([...order, ...chosen.map((_, i) => i)])].map((i) => chosen[i]!);
      const segLen = Math.max(3, T / seq.length);
      const timeline = seq.map((x) => ({ source_id: x.source_id, title: x.title, trim: 0, length: x.duration ? Math.min(segLen, x.duration) : segLen }));
      const hashtags = (j.hashtags ?? []).map((h: any) => "#" + String(h).replace(/^#/, "")).join(" ");
      await setPlan(c, { title: String(j.title ?? "Ролик"), claims, timeline, selection_note: "Ручная сборка: клипы выбраны по релевантности описания, нарезка по равным отрезкам (не анализ содержания кадров)." },
        { script: String(j.script ?? ""), caption: `${j.caption ?? ""}\n\n${hashtags}`, stage: "render_submit", attempts: 0, status: job.review_before_render ? "review" : "running" });
      return log(c, "plan", `Сценарий: «${j.title}», ${claims.length} фактов со ссылками, ${timeline.length} клипов`, "info", deps.now() - t);
    }
    case "render_submit": {
      if (job.render_id) { await patch(c, { stage: "render_wait" }); return; }
      if (!deps.shotstackConfigured()) return fail(c, "render_submit", "Не подключено: SHOTSTACK_API_KEY — план готов, но для сборки MP4 нужен рендерер.", "blocked");
      if (job.submit_state === "submitting") throw new ProviderError(AMBIGUOUS_MSG("Shotstack"), 0, false);
      const segs: Segment[] = [];
      for (const s of (plan.timeline ?? []) as { source_id: string; trim: number; length: number }[]) {
        const src = await source(c, s.source_id);
        if (!src) continue;
        let len = s.length;
        const url = await mediaUrl(c, src);
        if (!src.duration_s) { const d = await deps.probe(url); if (d) { await c.store.setSourceDuration(job.user_id, src.id, d); len = Math.min(len, d); } }
        segs.push({ url, trim: s.trim, length: len });
      }
      if (!segs.length) return fail(c, "render_submit", "Клипы из плана недоступны");
      const callbackUrl = c.opts.callbackBase ? `${c.opts.callbackBase}/api/public/shotstack-webhook?job=${job.id}&sig=${await deps.signJob(job.id)}` : undefined;
      const edit = buildEdit({ segments: segs, audioMode: job.audio_mode as any, script: job.script ?? "", language: job.language as any, callbackUrl });
      const id = await guardedSubmit(c, "Shotstack", "render_id", () => deps.submitRender(edit));
      await setPlan(c, { render_submitted_at: new Date(deps.now()).toISOString() }, { stage: "render_wait", attempts: 0 });
      return log(c, "render_submit", `Рендер отправлен в Shotstack (id ${id}, попытка ${job.render_attempt}, клипов: ${segs.length})`, "info", deps.now() - t);
    }
    case "render_wait": {
      const r = await deps.getRender(job.render_id!);
      if (r.status === "done" && r.url) { await setPlan(c, { render_url: r.url }, { stage: "finalize" }); return log(c, "render_wait", "Рендер завершён провайдером"); }
      if (r.status === "failed") return fail(c, "render_wait", `Shotstack: рендер не удался — ${r.error ?? "без описания"}`);
      if (plan.render_submitted_at && deps.now() - new Date(plan.render_submitted_at).getTime() > RENDER_TIMEOUT_MS) return fail(c, "render_wait", "Таймаут рендера (20 мин)");
      await patch(c, { next_attempt_at: new Date(deps.now() + 5000).toISOString() });
      return;
    }
    case "vizard_submit": {
      if (job.provider_project_id) { await patch(c, { stage: "vizard_wait" }); return; }
      if (job.submit_state === "submitting") throw new ProviderError(AMBIGUOUS_MSG("Vizard"), 0, false);
      const src = await source(c, job.source_id);
      if (!src) return fail(c, "vizard_submit", "Источник не найден");
      const url = src.kind === "upload" || src.kind === "direct_url" ? await mediaUrl(c, src) : src.url!;
      const body = buildSubmit({ url, kind: src.kind, lang: job.language, seconds: job.target_seconds, keywords: job.prompt, name: `inverk-${job.id.slice(0, 8)}`,
        ext: (src.storage_path ?? src.url ?? "").toLowerCase().endsWith(".mov") ? "mov" : "mp4" });
      const pid = await guardedSubmit(c, "Vizard", "provider_project_id", () => deps.vizardSubmit(body));
      await setPlan(c, { vizard_submitted_at: new Date(deps.now()).toISOString() }, { stage: "vizard_wait", attempts: 0, next_attempt_at: new Date(deps.now() + VIZARD_POLL_MS).toISOString() });
      return log(c, "vizard_submit", `Видео отправлено в Vizard (проект ${pid}). Обработка занимает от минут до десятков минут.`, "info", deps.now() - t);
    }
    case "vizard_wait": {
      const r = await deps.vizardQuery(job.provider_project_id!);
      if (r.state === "processing") {
        if (plan.vizard_submitted_at && deps.now() - new Date(plan.vizard_submitted_at).getTime() > VIZARD_TIMEOUT_MS) return fail(c, "vizard_wait", "Vizard не завершил обработку за 2 часа");
        await patch(c, { next_attempt_at: new Date(deps.now() + VIZARD_POLL_MS).toISOString() });
        return;
      }
      await setPlan(c, { vizard_clips: r.clips }, { stage: "vizard_select", attempts: 0 });
      return log(c, "vizard_wait", `Vizard вернул ${r.clips.length} клипов`, "info");
    }
    case "vizard_select": {
      const clips = (plan.vizard_clips ?? []) as VizardClip[];
      if (!clips.length) return fail(c, "vizard_select", "Vizard не вернул клипов");
      const j = await deps.ai("You pick the clip that best matches the user's request using the transcript. Return JSON only.",
        `Request: ${job.prompt}\nTarget length ${job.target_seconds}s. Caption language: ${LANG[job.language]}.\nClips:\n${clips.map((x, i) => `${i}. ${x.title} (${x.durationS.toFixed(0)}s, viral ${x.viralScore})\n${x.transcript.slice(0, 500)}`).join("\n")}\nReturn {best (index), reason (Russian), ranking:[indices], caption (<=150 chars), hashtags[3-6]}. Do not state facts absent from the transcript.`);
      const best = Math.max(0, Math.min(clips.length - 1, Number(j.best) || 0));
      const v = clips[best]!;
      const hashtags = (j.hashtags ?? []).map((h: any) => "#" + String(h).replace(/^#/, "")).join(" ");
      await setPlan(c, { title: v.title, chosen_clip: best, selection_note: `Vizard нарезал видео по содержанию; выбран клип ${best + 1}/${clips.length}: ${j.reason ?? ""}`, ranking: j.ranking },
        { caption: `${j.caption ?? v.title}\n\n${hashtags}`, script: v.transcript, stage: "finalize", status: job.review_before_render ? "review" : "running" });
      return log(c, "vizard_select", `Выбран клип «${v.title}» (${v.durationS.toFixed(0)} с)`, "info", deps.now() - t);
    }
    case "finalize": {
      const url: string | undefined = job.route === "vizard" ? plan.vizard_clips?.[plan.chosen_clip ?? 0]?.url : plan.render_url;
      if (!url) return fail(c, "finalize", "Нет ссылки на результат провайдера");
      const buf = await deps.fetchOutput(url, job.route);
      let meta;
      try { meta = inspectMp4(buf); assertTikTokReady(meta, job.route === "compose"); }
      catch (e) { return fail(c, "finalize", `Результат не прошёл проверку MP4: ${(e as Error).message}`); }
      const path = `${job.user_id}/${job.id}/r${job.render_attempt}${job.route === "vizard" ? `-c${plan.chosen_clip ?? 0}` : ""}.mp4`;
      await c.store.uploadOutput(path, buf);
      try {
        await patch(c, { output_path: path, output_mime: "video/mp4", output_bytes: buf.byteLength, status: "succeeded", stage: "done", finished_at: new Date(deps.now()).toISOString(), error: null,
          plan: { ...plan, output_meta: meta } as any });
      } catch (e) { if (e instanceof StaleLease) await c.store.removeOutput(path).catch(() => {}); throw e; }
      return log(c, "finalize", `MP4 проверен: H.264 ${meta.video!.width}×${meta.video!.height} + AAC, ${meta.durationS?.toFixed(1) ?? "?"} с, ${(buf.byteLength / 1048576).toFixed(1)} МБ`, "info", deps.now() - t);
    }
  }
}

async function ai(instructions: string, user: string): Promise<any> {
  const r: any = await generateResponse({ model: "openai/gpt-6-astra", instructions, input: [{ role: "user", content: user + "\nReturn JSON." }], text: { format: { type: "json_object" } } } as any);
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
  ai, tavilyConfigured, tavilySearch, pexelsConfigured, pexelsSearch, shotstackConfigured, submitRender, getRender, probe,
  vizardConfigured, vizardSubmit, vizardQuery, inspectDirectVideo, fetchOutput: (u, r) => fetchOutput(u, r), signJob, now: () => Date.now(),
});

/** Entry point for server code: admin client, one bounded stage. */
export async function runJobStage(jobId: string, opts: { callbackBase?: string | undefined } = {}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { supabaseStore } = await import("./pipeline-store.server");
  return processJob(supabaseStore(supabaseAdmin), realDeps(), jobId, opts);
}
