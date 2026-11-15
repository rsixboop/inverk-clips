// Durable, step-wise job pipeline. Each call advances a job by at most one stage under a DB lease,
// so no request blocks on multi-minute provider work. Called by UI polling, cron tick and webhooks.
// Routes: "compose" (research → discover → plan → Shotstack) and "vizard" (content-aware clipping).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { generateResponse } from "@lovable.dev/ai-gateway";
import { buildEdit, getRender, probe, shotstackConfigured, submitRender, type Segment } from "@/lib/shotstack";
import { ProviderError } from "@/lib/providers/http";
import { tavilySearch, tavilyConfigured, type ResearchHit } from "@/lib/providers/tavily";
import { pexelsConfigured, pexelsSearch } from "@/lib/providers/pexels";
import { buildSubmit, vizardConfigured, vizardQuery, vizardSubmit, type VizardClip } from "@/lib/providers/vizard";
import { inspectDirectVideo } from "@/lib/url-guard";

type DB = SupabaseClient<Database>;
type Job = Database["public"]["Tables"]["jobs"]["Row"];
type Src = Database["public"]["Tables"]["sources"]["Row"];
export type Candidate = { source_id: string; title: string; provider: string; kind: string; preview: string | null; duration: number | null; score: number; reason: string; selected: boolean; license: string };

const RENDER_TIMEOUT_MS = 20 * 60e3;
const VIZARD_TIMEOUT_MS = 120 * 60e3;
const VIZARD_POLL_MS = 30e3;
const MAX_ATTEMPTS = 4;
const backoff = (n: number) => Math.min(300, 15 * 2 ** n);
const LANG = { en: "English", ru: "Russian", uk: "Ukrainian" } as Record<string, string>;

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
const P = (job: Job): any => job.plan ?? {};
async function setPlan(db: DB, job: Job, add: Record<string, unknown>, extra: Partial<Job> = {}) {
  await patch(db, job, { plan: { ...P(job), ...add } as any, ...extra });
}

export async function processJob(db: DB, jobId: string, opts: { callbackBase?: string | undefined } = {}) {
  const now = new Date().toISOString();
  // single-worker lease: only one caller (UI tick, cron, webhook) can hold a job at a time
  const { data: leased } = await db.from("jobs")
    .update({ lock_until: new Date(Date.now() + 120_000).toISOString() })
    .eq("id", jobId).in("status", ["queued", "running"]).lte("next_attempt_at", now)
    .or(`lock_until.is.null,lock_until.lt.${now}`).select("*").maybeSingle();
  if (!leased) return;
  const job = leased as Job;
  try {
    if (job.status === "queued") await patch(db, job, { status: "running" });
    await step(db, job, opts);
  } catch (e) {
    const err = e as Error;
    const pe = e instanceof ProviderError ? e : null;
    if (pe?.retryable && !pe.ambiguous && job.attempts < MAX_ATTEMPTS) {
      const wait = backoff(job.attempts);
      await patch(db, job, { attempts: job.attempts + 1, next_attempt_at: new Date(Date.now() + wait * 1000).toISOString() });
      await log(db, job, job.stage, `${err.message} — повтор через ${wait} с (попытка ${job.attempts}/${MAX_ATTEMPTS})`, "warn");
    } else if (pe?.ambiguous && ["validate", "research", "discover", "plan", "render_wait", "vizard_wait", "finalize"].includes(job.stage) && job.attempts < MAX_ATTEMPTS) {
      // reads are safe to repeat; submissions are not (handled inside their steps)
      await patch(db, job, { attempts: job.attempts + 1, next_attempt_at: new Date(Date.now() + backoff(job.attempts) * 1000).toISOString() });
      await log(db, job, job.stage, `${err.message} — повтор чтения`, "warn");
    } else {
      await fail(db, job, job.stage, pe && !pe.retryable && pe.status === 0 && err.message.startsWith("Не подключено") ? err.message : err.message,
        err.message.startsWith("Не подключено") ? "blocked" : "failed");
    }
  } finally {
    await db.from("jobs").update({ lock_until: null }).eq("id", job.id);
  }
}

async function source(db: DB, id: string | null) {
  if (!id) return null;
  const { data } = await db.from("sources").select("*").eq("id", id).single();
  return data as Src | null;
}
async function mediaUrl(db: DB, s: Src): Promise<string> {
  if (s.kind === "upload") {
    const { data, error } = await db.storage.from("footage").createSignedUrl(s.storage_path!, 6 * 3600);
    if (error || !data) throw new Error("Не удалось подписать ссылку на загруженный файл");
    return data.signedUrl;
  }
  if (s.kind === "direct_url") return (await inspectDirectVideo(s.url!)).url;
  if (s.kind === "stock") return s.url!;
  throw new Error(`Источник типа ${s.kind} нельзя использовать как футаж`);
}

async function ai(instructions: string, user: string): Promise<any> {
  const r: any = await generateResponse({ model: "openai/gpt-6-astra", instructions, input: [{ role: "user", content: user + "\nReturn JSON." }], text: { format: { type: "json_object" } } } as any);
  let txt: string | undefined = r?.output_text;
  if (!txt) for (const o of r?.output ?? []) for (const c of o?.content ?? []) if (c?.type === "output_text") txt = c.text;
  if (!txt) throw new Error("Пустой ответ ИИ");
  try { return JSON.parse(txt); } catch { throw new Error("ИИ вернул некорректный JSON"); }
}

async function step(db: DB, job: Job, opts: { callbackBase?: string | undefined }) {
  const t = Date.now();
  const plan = P(job);
  switch (job.stage) {
    case "validate": {
      const src = await source(db, job.source_id);
      if (job.route === "vizard") {
        if (!src) return fail(db, job, "validate", "Для ИИ-нарезки нужна ссылка на видео или загруженный файл");
        if (!["youtube", "twitch", "direct_url", "upload"].includes(src.kind)) return fail(db, job, "validate", "Этот тип источника Vizard не принимает. Нужна ссылка на конкретное видео (YouTube, запись Twitch, прямой MP4) или файл.");
        if (src.permission === "unknown") return fail(db, job, "validate", "Укажите права на использование источника на странице «Источники».", "blocked");
        if (!vizardConfigured()) return fail(db, job, "validate", "Не подключено: VIZARD_API_KEY (ИИ-нарезка по ссылке). Добавьте секрет в настройках проекта.", "blocked");
        await patch(db, job, { stage: "vizard_submit", attempts: 0 });
        return log(db, job, "validate", `Источник принят для ИИ-нарезки: ${src.title}`);
      }
      if (src) {
        if (["youtube", "twitch", "channel", "research_link"].includes(src.kind)) return fail(db, job, "validate", "Для сборки нужен видеофайл. YouTube/Twitch — выберите маршрут «ИИ-нарезка (Vizard)». Канал — это не видео.");
        if (src.permission === "unknown") return fail(db, job, "validate", "Укажите права на использование источника на странице «Источники».", "blocked");
      } else if (job.mode === "link") return fail(db, job, "validate", "Режим «По ссылке» требует источник");
      await patch(db, job, { stage: job.mode === "link" ? "discover" : "research", attempts: 0 });
      return log(db, job, "validate", src ? `Источник проверен: ${src.title}` : "Без исходника — футаж будет найден автоматически");
    }
    case "research": {
      if (!tavilyConfigured()) return fail(db, job, "research", "Не подключено: TAVILY_API_KEY — без веб-поиска факты в сценарии не будут подтверждены.", "blocked");
      const q = await ai("You prepare search queries. Return JSON only.",
        `For this short-video request produce: search_query (English web search query for current factual info, <=12 words), stock_query (2-4 English words for generic stock B-roll that would genuinely fit; empty string if only gameplay/specific footage fits), needs_specific_footage (true if the topic needs specific footage such as game gameplay, a named person or product that generic stock cannot show).\nRequest: ${job.prompt}`);
      const hits = await tavilySearch(String(q.search_query || job.prompt));
      await setPlan(db, job, { research: hits, search_query: q.search_query, stock_query: String(q.stock_query ?? ""), needs_specific_footage: !!q.needs_specific_footage }, { stage: "discover", attempts: 0 });
      return log(db, job, "research", `Веб-поиск: ${hits.length} источников по запросу «${q.search_query}»`, "info", Date.now() - t);
    }
    case "discover": {
      const pool: Src[] = [];
      const own = await source(db, job.source_id);
      if (own) pool.push(own);
      const { data: lib } = await db.from("sources").select("*").in("kind", ["upload", "direct_url", "stock"]).eq("status", "ready").neq("permission", "unknown").order("created_at", { ascending: false }).limit(30);
      for (const s of (lib ?? []) as Src[]) if (!pool.some((p) => p.id === s.id)) pool.push(s);
      const notes: string[] = [];
      if (job.mode !== "link" && plan.stock_query) {
        if (!pexelsConfigured()) notes.push("Pexels не подключён (PEXELS_API_KEY) — стоковый поиск пропущен.");
        else {
          for (const c of await pexelsSearch(plan.stock_query)) {
            const { data: ex } = await db.from("sources").select("*").eq("provider", "pexels").eq("external_id", c.externalId).maybeSingle();
            const row = ex ?? (await db.from("sources").insert({ user_id: job.user_id, kind: "stock", provider: "pexels", external_id: c.externalId, url: c.fileUrl, preview_url: c.preview,
              title: c.title || `Pexels ${c.externalId}`, mime: "video/mp4", duration_s: c.duration, permission: "licensed", license: "Pexels License (free use, attribution appreciated)",
              attribution: `${c.author} — ${c.pageUrl}`, permission_note: c.pageUrl }).select("*").single()).data;
            if (row && !pool.some((p) => p.id === row.id)) pool.push(row as Src);
          }
        }
      }
      if (!pool.length) return fail(db, job, "discover", `Подходящий лицензированный футаж не найден. ${notes.join(" ")} Добавьте разрешённое видео в «Источники».`, "blocked");
      const judged = await ai("You judge whether footage can honestly illustrate a video. Generic stock (city, cars) is NOT game gameplay; never mark it relevant for gameplay-specific claims. Return JSON only.",
        `Request: ${job.prompt}\nNeeds specific footage: ${!!plan.needs_specific_footage}\nCandidates:\n${pool.map((s, i) => `${i}. [${s.provider}/${s.kind}] ${s.title} ${s.permission_note ? "(" + s.permission_note.slice(0, 80) + ")" : ""}`).join("\n")}\nReturn {items:[{i, score (0-1), reason (Russian, short)}]} for every candidate.`);
      const cands: Candidate[] = pool.map((s, i) => {
        const it = (judged.items ?? []).find((x: any) => Number(x.i) === i) ?? {};
        const score = Math.max(0, Math.min(1, Number(it.score) || 0));
        return { source_id: s.id, title: s.title, provider: s.provider, kind: s.kind, preview: s.preview_url, duration: s.duration_s ? Number(s.duration_s) : null, score, reason: String(it.reason ?? ""), selected: score >= 0.6 || s.id === job.source_id, license: s.license || s.permission };
      }).sort((a, b) => b.score - a.score).slice(0, 12);
      const chosen = cands.filter((c) => c.selected);
      if (!chosen.length) {
        await setPlan(db, job, { candidates: cands, gap: `Нет релевантного лицензированного футажа${plan.needs_specific_footage ? " (нужен конкретный материал, например геймплей)" : ""}. Стоковые ролики не подменяют геймплей. Добавьте разрешённый источник или отметьте кандидатов вручную.` }, { stage: "plan", status: "review" });
        return log(db, job, "discover", "Пробел в футаже: релевантных кандидатов нет — нужна ваша проверка", "warn");
      }
      await setPlan(db, job, { candidates: cands, gap: null, discover_notes: notes }, { stage: "plan", attempts: 0, ...(job.approve_sources ? { status: "review" } : {}) });
      return log(db, job, "discover", `Найдено ${cands.length} кандидатов, выбрано ${chosen.length}. ${notes.join(" ")}`, "info", Date.now() - t);
    }
    case "plan": {
      const chosen = ((plan.candidates ?? []) as Candidate[]).filter((c) => c.selected);
      if (!chosen.length) return fail(db, job, "plan", "Не выбрано ни одного клипа", "blocked");
      const hits = (plan.research ?? []) as ResearchHit[];
      const T = job.target_seconds;
      const j = await ai(`You write short vertical-video scripts. Use ONLY facts supported by the numbered search results; cite them by number. If results don't support a fact, don't state it. Never present GTA VI gameplay/leaks as real. Return JSON only.`,
        `Language: ${LANG[job.language]}. Target ${T}s; voiceover must be about ${Math.round(T * 2.4)} words (spoken only, no stage directions).
Request: ${job.prompt}
Search results:\n${hits.map((h, i) => `[${i}] ${h.title} — ${h.url}\n${h.snippet}`).join("\n") || "(none — avoid factual claims)"}
Clips in order: ${chosen.map((c, i) => `${i}:${c.title}(${c.duration ?? "?"}s)`).join("; ")}
Return {title, script, caption (<=150 chars), hashtags[3-6], claims:[{claim, ref (result number)}], order: [clip indices in the best order]}.`);
      const claims = (Array.isArray(j.claims) ? j.claims : []).map((c: any) => ({ claim: String(c.claim), hit: hits[Number(c.ref)] })).filter((c: any) => c.hit)
        .map((c: any) => ({ claim: c.claim, source_url: c.hit.url, source_title: c.hit.title, status: "sourced" }));
      const order: number[] = (Array.isArray(j.order) ? j.order : []).map(Number).filter((n: number) => n >= 0 && n < chosen.length);
      const seq = [...new Set([...order, ...chosen.map((_, i) => i)])].map((i) => chosen[i]!);
      const segLen = Math.max(3, T / seq.length);
      const timeline = seq.map((c) => ({ source_id: c.source_id, title: c.title, trim: 0, length: c.duration ? Math.min(segLen, c.duration) : segLen }));
      const hashtags = (j.hashtags ?? []).map((h: any) => "#" + String(h).replace(/^#/, "")).join(" ");
      await setPlan(db, job, { title: String(j.title ?? "Ролик"), claims, timeline, selection_note: "Ручная сборка: клипы выбраны по релевантности описания, нарезка по равным отрезкам (не анализ содержания кадров)." },
        { script: String(j.script ?? ""), caption: `${j.caption ?? ""}\n\n${hashtags}`, stage: "render_submit", attempts: 0, status: job.review_before_render ? "review" : "running" });
      return log(db, job, "plan", `Сценарий: «${j.title}», ${claims.length} фактов со ссылками, ${timeline.length} клипов`, "info", Date.now() - t);
    }
    case "render_submit": {
      if (job.render_id) { await patch(db, job, { stage: "render_wait" }); return; }
      if (!shotstackConfigured()) return fail(db, job, "render_submit", "Не подключено: SHOTSTACK_API_KEY — план готов, но для сборки MP4 нужен рендерер.", "blocked");
      const segs: Segment[] = [];
      for (const s of (plan.timeline ?? []) as { source_id: string; trim: number; length: number }[]) {
        const src = await source(db, s.source_id);
        if (!src) continue;
        let len = s.length;
        if (!src.duration_s) { const d = await probe(await mediaUrl(db, src)); if (d) { await db.from("sources").update({ duration_s: d }).eq("id", src.id); len = Math.min(len, d); } }
        segs.push({ url: await mediaUrl(db, src), trim: s.trim, length: len });
      }
      if (!segs.length) return fail(db, job, "render_submit", "Клипы из плана недоступны");
      const attempt = job.render_attempt + 1;
      const { data: claimed } = await db.from("jobs").update({ render_attempt: attempt }).eq("id", job.id).eq("render_attempt", job.render_attempt).is("render_id", null).select("id").maybeSingle();
      if (!claimed) return;
      job.render_attempt = attempt;
      const callbackUrl = opts.callbackBase ? `${opts.callbackBase}/api/public/shotstack-webhook?job=${job.id}&sig=${await signJob(job.id)}` : undefined;
      let id: string;
      try { id = await submitRender(buildEdit({ segments: segs, audioMode: job.audio_mode as any, script: job.script ?? "", language: job.language as any, callbackUrl })); }
      catch (e) {
        if (e instanceof ProviderError && e.ambiguous) throw new ProviderError(`Неизвестный исход отправки рендера (${e.message}). Автоповтор отключён во избежание двойной оплаты — проверьте Shotstack и нажмите «Повторить шаг».`, 0, false);
        throw e;
      }
      await patch(db, job, { render_id: id, stage: "render_wait", attempts: 0, plan: { ...plan, render_submitted_at: new Date().toISOString() } as any });
      return log(db, job, "render_submit", `Рендер отправлен в Shotstack (id ${id}, попытка ${attempt}, клипов: ${segs.length})`, "info", Date.now() - t);
    }
    case "render_wait": {
      const r = await getRender(job.render_id!);
      if (r.status === "done" && r.url) { await setPlan(db, job, { render_url: r.url }, { stage: "finalize" }); return log(db, job, "render_wait", "Рендер завершён провайдером"); }
      if (r.status === "failed") return fail(db, job, "render_wait", `Shotstack: рендер не удался — ${r.error ?? "без описания"}`);
      if (plan.render_submitted_at && Date.now() - new Date(plan.render_submitted_at).getTime() > RENDER_TIMEOUT_MS) return fail(db, job, "render_wait", "Таймаут рендера (20 мин)");
      await patch(db, job, { next_attempt_at: new Date(Date.now() + 5000).toISOString() });
      return;
    }
    case "vizard_submit": {
      if (job.provider_project_id) { await patch(db, job, { stage: "vizard_wait" }); return; }
      const src = await source(db, job.source_id);
      if (!src) return fail(db, job, "vizard_submit", "Источник не найден");
      const url = src.kind === "upload" || src.kind === "direct_url" ? await mediaUrl(db, src) : src.url!;
      const attempt = job.render_attempt + 1;
      const { data: claimed } = await db.from("jobs").update({ render_attempt: attempt }).eq("id", job.id).eq("render_attempt", job.render_attempt).is("provider_project_id", null).select("id").maybeSingle();
      if (!claimed) return;
      job.render_attempt = attempt;
      let pid: string;
      try {
        pid = await vizardSubmit(buildSubmit({ url, kind: src.kind, lang: job.language, seconds: job.target_seconds, keywords: job.prompt, name: `inverk-${job.id.slice(0, 8)}`,
          ext: (src.storage_path ?? src.url ?? "").toLowerCase().endsWith(".mov") ? "mov" : "mp4" }));
      } catch (e) {
        if (e instanceof ProviderError && e.ambiguous) throw new ProviderError(`Неизвестный исход отправки в Vizard (${e.message}). Автоповтор отключён во избежание двойного списания — проверьте кабинет Vizard и нажмите «Повторить шаг».`, 0, false);
        throw e;
      }
      await patch(db, job, { provider_project_id: pid, stage: "vizard_wait", attempts: 0, next_attempt_at: new Date(Date.now() + VIZARD_POLL_MS).toISOString(), plan: { ...plan, vizard_submitted_at: new Date().toISOString() } as any });
      return log(db, job, "vizard_submit", `Видео отправлено в Vizard (проект ${pid}). Обработка занимает от минут до десятков минут.`, "info", Date.now() - t);
    }
    case "vizard_wait": {
      const r = await vizardQuery(job.provider_project_id!);
      if (r.state === "processing") {
        if (plan.vizard_submitted_at && Date.now() - new Date(plan.vizard_submitted_at).getTime() > VIZARD_TIMEOUT_MS) return fail(db, job, "vizard_wait", "Vizard не завершил обработку за 2 часа");
        await patch(db, job, { next_attempt_at: new Date(Date.now() + VIZARD_POLL_MS).toISOString() }); // provider polled no more than every 30 s
        return;
      }
      await setPlan(db, job, { vizard_clips: r.clips }, { stage: "vizard_select", attempts: 0 });
      return log(db, job, "vizard_wait", `Vizard вернул ${r.clips.length} клипов`, "info");
    }
    case "vizard_select": {
      const clips = (plan.vizard_clips ?? []) as VizardClip[];
      if (!clips.length) return fail(db, job, "vizard_select", "Vizard не вернул клипов");
      const j = await ai("You pick the clip that best matches the user's request using the transcript. Return JSON only.",
        `Request: ${job.prompt}\nTarget length ${job.target_seconds}s. Caption language: ${LANG[job.language]}.\nClips:\n${clips.map((c, i) => `${i}. ${c.title} (${c.durationS.toFixed(0)}s, viral ${c.viralScore})\n${c.transcript.slice(0, 500)}`).join("\n")}\nReturn {best (index), reason (Russian), ranking:[indices], caption (<=150 chars), hashtags[3-6]}. Do not state facts absent from the transcript.`);
      const best = Math.max(0, Math.min(clips.length - 1, Number(j.best) || 0));
      const c = clips[best]!;
      const hashtags = (j.hashtags ?? []).map((h: any) => "#" + String(h).replace(/^#/, "")).join(" ");
      await setPlan(db, job, { title: c.title, chosen_clip: best, selection_note: `Vizard нарезал видео по содержанию; выбран клип ${best + 1}/${clips.length}: ${j.reason ?? ""}`, render_url: c.url, ranking: j.ranking },
        { caption: `${j.caption ?? c.title}\n\n${hashtags}`, script: c.transcript, stage: "finalize", status: job.review_before_render ? "review" : "running" });
      return log(db, job, "vizard_select", `Выбран клип «${c.title}» (${c.durationS.toFixed(0)} с)`, "info", Date.now() - t);
    }
    case "finalize": {
      if (job.route === "vizard" && plan.vizard_clips && plan.chosen_clip != null) plan.render_url = plan.vizard_clips[plan.chosen_clip]?.url ?? plan.render_url;
      const res = await fetch(plan.render_url, { signal: AbortSignal.timeout(55000) });
      if (!res.ok) throw new ProviderError(`Не удалось скачать результат: ${res.status}`, res.status, true);
      const buf = new Uint8Array(await res.arrayBuffer());
      const ftyp = new TextDecoder().decode(buf.slice(4, 8));
      if (buf.byteLength < 10_000 || ftyp !== "ftyp") return fail(db, job, "finalize", `Результат не похож на MP4 (размер ${buf.byteLength} байт, сигнатура «${ftyp}»)`);
      const path = `${job.user_id}/${job.id}/r${job.render_attempt}${job.route === "vizard" ? `-c${plan.chosen_clip ?? 0}` : ""}.mp4`;
      const { error } = await db.storage.from("outputs").upload(path, buf, { contentType: "video/mp4", upsert: true });
      if (error) throw new Error(`Сохранение MP4: ${error.message}`);
      await patch(db, job, { output_path: path, output_mime: "video/mp4", output_bytes: buf.byteLength, status: "succeeded", stage: "done", finished_at: new Date().toISOString(), error: null });
      return log(db, job, "finalize", `MP4 проверен (сигнатура ftyp) и сохранён: ${(buf.byteLength / 1048576).toFixed(1)} МБ`, "info", Date.now() - t);
    }
  }
}

export async function signJob(jobId: string) {
  const secret = process.env["WEBHOOK_SIGNING_SECRET"] ?? "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(jobId));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}
