// Official schemas: https://fal.ai/models/<endpoint>/api and queue OpenAPI.
import { ProviderError, providerFetch } from "./http";
import { parsePublicUrl } from "../url-guard";

export const FAL = {
  // ffmpeg-api/* answers 403 "Access denied" for this account (verified 2026-11-16); kept only for the
  // legacy compose/clip routes, which the capability preflight now blocks before any paid call.
  whisper: "fal-ai/whisper", metadata: "fal-ai/ffmpeg-api/metadata", compose: "fal-ai/ffmpeg-api/compose",
  trim: "fal-ai/workflow-utilities/trim-video", scale: "fal-ai/workflow-utilities/scale-video",
  frames: "fal-ai/workflow-utilities/extract-nth-frame", captions: "fal-ai/workflow-utilities/auto-subtitle",
  tts: "fal-ai/kokoro/american-english", image: "fal-ai/nano-banana", imageEdit: "fal-ai/nano-banana/edit",
  removeBg: "fal-ai/imageutils/rembg", i2vLite: "fal-ai/bytedance/seedance/v1/lite/image-to-video", videoMatte: "fal-ai/birefnet/v2/video",
  i2v: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video", sfx: "fal-ai/mmaudio-v2/text-to-audio",
} as const;
export const falConfigured = () => Boolean(process.env["FAL_KEY"]);
function headers() {
  const key = process.env["FAL_KEY"];
  if (!key) throw new ProviderError("Не подключено: FAL_KEY", 0, false);
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}
export function queueBase(model: string) {
  if (!Object.values(FAL).some((m) => m === model)) throw new Error("Неподдерживаемая операция fal.ai");
  // Queue retrieval uses the app ID (first two segments), not endpoint subpath.
  return `https://queue.fal.run/${model.split("/").slice(0, 2).join("/")}`;
}
export function providerMedia(raw: unknown): string {
  if (typeof raw !== "string") throw new ProviderError("Провайдер не вернул файл", 0, false);
  return parsePublicUrl(raw).toString();
}
export async function falSubmit(model: string, input: Record<string, unknown>): Promise<string> {
  queueBase(model);
  const j = await providerFetch(`fal.ai ${model}`, `https://queue.fal.run/${model}`, { method: "POST", headers: headers(), body: JSON.stringify(input) });
  if (typeof j.request_id !== "string" || !j.request_id) throw new ProviderError("fal.ai: не получен ID; исход отправки неизвестен", 0, false, true);
  return j.request_id;
}
export async function falPoll(model: string, id: string): Promise<{ state: "processing" } | { state: "done"; result: Record<string, any> }> {
  const base = `${queueBase(model)}/requests/${encodeURIComponent(id)}`;
  const j = await providerFetch(`fal.ai ${model}`, `${base}/status`, { headers: headers() });
  if (["IN_QUEUE", "IN_PROGRESS"].includes(j.status)) return { state: "processing" };
  if (j.status !== "COMPLETED") throw new ProviderError("fal.ai: неизвестный статус запроса", 0, false);
  if (j.error) throw new ProviderError("fal.ai: запрос завершился ошибкой; проверьте кабинет провайдера", 0, false);
  const result = await providerFetch(`fal.ai ${model}`, base, { headers: headers() });
  if (result.error || result.detail) throw new ProviderError("fal.ai: обработка не удалась; проверьте запрос в кабинете", 0, false);
  return { state: "done", result };
}
export function scaleInput(url: string) { return { video_url: url, width: 1080, height: 1920, mode: "crop", codec: "libx264", preset: "fast", crf: 23 }; }
export function captionInput(url: string, language: string) {
  return { video_url: url, language, font_name: "Montserrat", font_size: 64, font_weight: "bold", highlight_color: "green", position: "bottom", y_offset: -200, words_per_subtitle: 3, enable_animation: false };
}
/** fal workflow-utilities/extract-nth-frame: every 12th frame; the last image is the shot's end frame. */
export function endFramesInput(url: string) { return { video_url: url, frame_interval: 12, max_frames: 30, output_format: "png" }; }

// ---- Capability preflight: an empty-body POST to the sync endpoint is rejected before any work runs
// (422 = endpoint usable, 403 = denied for this account, 401 = bad key). Bounded in-memory cache.
export type Capability = { model: string; ok: boolean | null; status: number; reason: string };
const CAP_TTL_MS = 15 * 60e3, CAP_MAX = 32, capCache = new Map<string, { at: number; cap: Capability }>();
export function readCapability(model: string, status: number, text: string): Capability {
  if (status === 422 || status === 400) return { model, ok: true, status, reason: "доступен" };
  if (status === 401) return { model, ok: false, status, reason: "ключ FAL_KEY отклонён (401)" };
  if (status === 403) return { model, ok: false, status, reason: /not_priced|not available/i.test(text) ? "эндпоинт не опубликован для оплаты (403)" : "нет доступа к эндпоинту для этого аккаунта fal (403)" };
  return { model, ok: null, status, reason: `не проверено (${status || "сеть"})` };
}
export async function falCapabilities(models: string[], now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<Capability[]> {
  const key = process.env["FAL_KEY"];
  return Promise.all([...new Set(models)].map(async (model) => {
    const hit = capCache.get(model);
    if (hit && now - hit.at < CAP_TTL_MS) return hit.cap;
    let cap: Capability;
    try {
      const r = await fetchImpl(`https://fal.run/${model}`, { method: "POST", headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(8000) });
      cap = readCapability(model, r.status, await r.text());
    } catch { cap = readCapability(model, 0, ""); }
    if (cap.ok !== null) { if (capCache.size >= CAP_MAX) capCache.delete(capCache.keys().next().value!); capCache.set(model, { at: now, cap }); }
    return cap;
  }));
}

export type Moment = { title: string; start: number; durationS: number; transcript: string; reason: string };
export function validMoments(items: unknown, duration: number, target: number): Moment[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((m) => {
    const start = Number(m.start), length = Number(m.durationS);
    if (!Number.isFinite(start) || !Number.isFinite(length) || start < 0 || start >= duration || length <= 0) return [];
    return [{ title: String(m.title ?? "Фрагмент"), start, durationS: Math.min(length, target, duration - start), transcript: String(m.transcript ?? ""), reason: String(m.reason ?? "") }];
  }).slice(0, 5);
}