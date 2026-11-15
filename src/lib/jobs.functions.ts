import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runJobStage } from "@/server/pipeline.server";
import { shotstackConfigured, shotstackEnv } from "@/lib/shotstack";
import { tavilyConfigured } from "@/lib/providers/tavily";
import { pexelsConfigured } from "@/lib/providers/pexels";
import { vizardConfigured } from "@/lib/providers/vizard";
import { classifyUrl, inspectDirectVideo, parsePublicUrl } from "@/lib/url-guard";

function origin() {
  try { const u = new URL(getRequest().url); return u.hostname === "localhost" ? undefined : u.origin; } catch { return undefined; }
}

async function admin() { return (await import("@/integrations/supabase/client.server")).supabaseAdmin; }

// One bounded stage per request: the caller's RLS-scoped client picks its own most-due job, then the
// fenced pipeline advances it once. The UI polls again for the next stage.
export const tickJobs = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data } = await context.supabase.from("jobs").select("id").eq("user_id", context.userId).in("status", ["queued", "running"])
    .lte("next_attempt_at", new Date().toISOString()).order("next_attempt_at").limit(1);
  const j = data?.[0];
  if (!j) return { processed: 0 };
  await runJobStage(j.id, { callbackBase: origin() });
  return { processed: 1 };
});

export const providerStatus = createServerFn({ method: "GET" }).middleware([requireSupabaseAuth]).handler(async () => ({
  shotstack: shotstackConfigured(), shotstackEnv: shotstackEnv(), tavily: tavilyConfigured(), pexels: pexelsConfigured(), vizard: vizardConfigured(), ai: !!process.env["LOVABLE_API_KEY"], tiktok: false, webhookSigning: !!process.env["WEBHOOK_SIGNING_SECRET"],
}));

const createSchema = z.object({
  idempotencyKey: z.string().min(8).max(64), mode: z.enum(["niche", "link", "mixed"]), prompt: z.string().max(2000),
  language: z.enum(["en", "ru", "uk"]), targetSeconds: z.number().int().min(10).max(90), audioMode: z.enum(["voiceover", "original"]),
  reviewBeforeRender: z.boolean(), approveSources: z.boolean(), route: z.enum(["compose", "vizard"]), nicheId: z.string().uuid().nullable(), sourceId: z.string().uuid().nullable(),
});
export const createJob = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((d: unknown) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: existing } = await context.supabase.from("jobs").select("id").eq("idempotency_key", data.idempotencyKey).maybeSingle();
    if (existing) return { id: existing.id, duplicate: true };
    const { data: row, error } = await context.supabase.from("jobs").insert({
      user_id: context.userId, idempotency_key: data.idempotencyKey, mode: data.mode, prompt: data.prompt, language: data.language,
      target_seconds: data.targetSeconds, audio_mode: data.audioMode, review_before_render: data.reviewBeforeRender, approve_sources: data.approveSources, route: data.mode === "link" ? data.route : "compose", niche_id: data.nicheId, source_id: data.sourceId,
    }).select("id").single();
    if (error) {
      if (error.code === "23505") return { id: (await context.supabase.from("jobs").select("id").eq("idempotency_key", data.idempotencyKey).single()).data!.id, duplicate: true };
      throw new Error(error.message);
    }
    await (await admin()).from("job_events").insert({ job_id: row.id, user_id: context.userId, stage: "validate", message: "Задача создана" });
    return { id: row.id, duplicate: false };
  });

const actionSchema = z.object({ jobId: z.string().uuid(), action: z.enum(["cancel", "pause", "resume", "retry", "regenerate", "approve", "rerender"]), confirmResubmit: z.boolean().optional() });
export const jobAction = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((d: unknown) => actionSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: job } = await context.supabase.from("jobs").select("*").eq("id", data.jobId).eq("user_id", context.userId).maybeSingle();
    if (!job) throw new Error("Задача не найдена");
    const now = new Date().toISOString();
    const deadline = new Date(Date.now() + 3 * 3600e3).toISOString();
    // clearing lease_token fences out any in-flight worker: its later writes match 0 rows and are discarded
    const upd: Record<string, unknown> = { updated_at: now, next_attempt_at: now, lock_until: null, lease_token: null };
    const ambiguous = job.submit_state === "submitting" && !job.render_id && !job.provider_project_id;
    let msg = "";
    const active = ["queued", "running", "review", "paused", "blocked"].includes(job.status);
    switch (data.action) {
      case "cancel": if (!active) throw new Error("Задача уже завершена");
        Object.assign(upd, { status: "cancelled", finished_at: now });
        msg = job.render_id && job.stage === "render_wait" ? "Отменено. Shotstack не поддерживает отмену — начатый рендер может доиграть у провайдера, но результат не будет использован." : "Отменено пользователем"; break;
      case "pause": if (!["queued", "running"].includes(job.status)) throw new Error("Нечего ставить на паузу");
        upd["status"] = "paused"; msg = "Пауза"; break;
      case "resume": if (job.status !== "paused") throw new Error("Задача не на паузе");
        upd["status"] = "running"; msg = "Продолжено"; break;
      case "retry": if (!["failed", "blocked", "cancelled"].includes(job.status)) throw new Error("Повтор доступен только после ошибки/блокировки/отмены");
        if (ambiguous && !data.confirmResubmit) throw new Error("Исход прошлой платной отправки неизвестен. Проверьте кабинет провайдера и подтвердите повторную отправку — возможна двойная оплата.");
        Object.assign(upd, { status: "running", stage: job.failed_stage ?? job.stage, error: null, attempts: 0, finished_at: null, deadline_at: deadline, ...(ambiguous ? { submit_state: null } : {}) });
        msg = `Повтор шага «${job.failed_stage ?? job.stage}»${ambiguous ? " — пользователь подтвердил повторную платную отправку" : job.render_id ? " (существующий рендер не дублируется)" : ""}`; break;
      case "regenerate": if (job.status === "running" && ["render_wait", "finalize"].includes(job.stage)) throw new Error("Идёт рендер — сначала отмените");
        if (job.route === "vizard") throw new Error("Для ИИ-нарезки выберите другой клип из кандидатов");
        Object.assign(upd, { status: "running", stage: job.plan ? "plan" : "validate", render_id: null, submit_state: null, error: null, attempts: 0, finished_at: null, deadline_at: deadline }); msg = "Перегенерация сценария"; break;
      case "approve": if (job.status !== "review") throw new Error("Сценарий не ожидает проверки");
        upd["status"] = "running"; msg = "Утверждено, продолжаю"; break;
      case "rerender": if (!["succeeded", "failed"].includes(job.status)) throw new Error("Повторный рендер — только для завершённых задач");
        if (job.route === "vizard") { Object.assign(upd, { status: "running", stage: "finalize", error: null, attempts: 0, finished_at: null, deadline_at: deadline }); msg = "Сохраняю выбранный клип Vizard (без новой оплаты)"; break; }
        Object.assign(upd, { status: "running", stage: "render_submit", render_id: null, submit_state: null, error: null, attempts: 0, finished_at: null, deadline_at: deadline }); msg = "Новый рендер с текущим сценарием (будет списана новая минута рендера)"; break;
    }
    const db = await admin(); // internal fields are not user-writable; ownership verified above and re-checked here
    const { data: rows, error } = await db.from("jobs").update(upd as any).eq("id", job.id).eq("user_id", context.userId).eq("updated_at", job.updated_at).select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("Состояние задачи изменилось — обновите и попробуйте снова");
    await db.from("job_events").insert({ job_id: job.id, user_id: context.userId, stage: job.stage, message: msg });
    return { ok: true };
  });

// Candidate / clip choice: validated server-side, only the selection flags change.
export const selectCandidates = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ jobId: z.string().uuid(), selected: z.array(z.number().int().min(0).max(50)).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: job } = await context.supabase.from("jobs").select("*").eq("id", data.jobId).eq("user_id", context.userId).maybeSingle();
    if (!job) throw new Error("Задача не найдена");
    if (job.status !== "review" || job.stage !== "plan") throw new Error("Выбор футажа доступен только на шаге проверки");
    const plan = (job.plan ?? {}) as any;
    const cands = ((plan.candidates ?? []) as any[]).map((c, i) => ({ ...c, selected: data.selected.includes(i) }));
    const { data: rows } = await (await admin()).from("jobs").update({ plan: { ...plan, candidates: cands }, updated_at: new Date().toISOString() })
      .eq("id", job.id).eq("user_id", context.userId).eq("updated_at", job.updated_at).select("id");
    if (!rows?.length) throw new Error("Состояние задачи изменилось — обновите");
    return { ok: true };
  });
export const pickClip = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ jobId: z.string().uuid(), index: z.number().int().min(0).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: job } = await context.supabase.from("jobs").select("*").eq("id", data.jobId).eq("user_id", context.userId).maybeSingle();
    if (!job || job.route !== "vizard") throw new Error("Задача не найдена");
    if (!["review", "succeeded", "failed"].includes(job.status)) throw new Error("Сейчас клип выбрать нельзя");
    const plan = (job.plan ?? {}) as any;
    const clip = plan.vizard_clips?.[data.index];
    if (!clip) throw new Error("Нет такого клипа");
    const { data: rows } = await (await admin()).from("jobs").update({ plan: { ...plan, chosen_clip: data.index, title: clip.title }, updated_at: new Date().toISOString() })
      .eq("id", job.id).eq("user_id", context.userId).eq("updated_at", job.updated_at).select("id");
    if (!rows?.length) throw new Error("Состояние задачи изменилось — обновите");
    return { ok: true };
  });

export const getOutputUrl = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((d: unknown) => z.object({ jobId: z.string().uuid(), download: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: job } = await context.supabase.from("jobs").select("id,output_path,status").eq("id", data.jobId).single();
    if (!job?.output_path || job.status !== "succeeded") throw new Error("Готового MP4 нет");
    const { data: s, error } = await context.supabase.storage.from("outputs").createSignedUrl(job.output_path, 3600, data.download ? { download: `inverk-${job.id.slice(0, 8)}.mp4` } : undefined);
    if (error) throw new Error(error.message);
    return { url: s.signedUrl };
  });

const urlSchema = z.object({ url: z.string().max(2000), permission: z.enum(["owned", "licensed", "permitted", "unknown"]), note: z.string().max(500) });
export const addUrlSource = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator((d: unknown) => urlSchema.parse(d))
  .handler(async ({ data, context }) => {
    const u = parsePublicUrl(data.url);
    let kind: string = classifyUrl(u);
    let status = "ready", status_note = "", mime: string | null = null, bytes: number | null = null, url = u.toString();
    if (kind === "youtube" || kind === "twitch") { status_note = "Доступно только для ИИ-нарезки через Vizard (официальный API принимает ссылку). Приложение само видео не скачивает."; }
    else if (kind === "channel") { status = "reference"; status_note = "Канал сохранён как ссылка-ориентир. Это не видео: укажите конкретный ролик/запись. Запись прямых эфиров не поддерживается."; }
    else {
      try { const info = await inspectDirectVideo(url); kind = "direct_url"; url = info.url; mime = info.mime; bytes = info.bytes; }
      catch (e) { if (kind === "page") { kind = "research_link"; status = "reference"; status_note = `Не видеофайл: ${(e as Error).message}. Сохранено как ссылка-источник.`; } else throw e; }
    }
    const { data: row, error } = await (await admin()).from("sources").insert({ user_id: context.userId, kind, url, title: u.hostname + u.pathname.slice(0, 60), mime, bytes, permission: data.permission, permission_note: data.note, status, status_note }).select("*").single();
    if (error) throw new Error(error.message);
    return row;
  });
