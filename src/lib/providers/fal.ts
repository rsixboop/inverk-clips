// Official schemas: https://fal.ai/models/<endpoint>/api and queue OpenAPI.
import { ProviderError, providerFetch } from "./http";
import { parsePublicUrl } from "../url-guard";

export const FAL = {
  whisper: "fal-ai/whisper", metadata: "fal-ai/ffmpeg-api/metadata", compose: "fal-ai/ffmpeg-api/compose",
  trim: "fal-ai/workflow-utilities/trim-video", scale: "fal-ai/workflow-utilities/scale-video",
  frames: "fal-ai/workflow-utilities/extract-nth-frame", captions: "fal-ai/workflow-utilities/auto-subtitle",
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
  const j = await providerFetch("fal.ai", `https://queue.fal.run/${model}`, { method: "POST", headers: headers(), body: JSON.stringify(input) });
  if (typeof j.request_id !== "string" || !j.request_id) throw new ProviderError("fal.ai: не получен ID; исход отправки неизвестен", 0, false, true);
  return j.request_id;
}
export async function falPoll(model: string, id: string): Promise<{ state: "processing" } | { state: "done"; result: Record<string, any> }> {
  const base = `${queueBase(model)}/requests/${encodeURIComponent(id)}`;
  const j = await providerFetch("fal.ai", `${base}/status`, { headers: headers() });
  if (["IN_QUEUE", "IN_PROGRESS"].includes(j.status)) return { state: "processing" };
  if (j.status !== "COMPLETED") throw new ProviderError("fal.ai: неизвестный статус запроса", 0, false);
  if (j.error) throw new ProviderError("fal.ai: запрос завершился ошибкой; проверьте кабинет провайдера", 0, false);
  const result = await providerFetch("fal.ai", base, { headers: headers() });
  if (result.error || result.detail) throw new ProviderError("fal.ai: обработка не удалась; проверьте запрос в кабинете", 0, false);
  return { state: "done", result };
}
export function scaleInput(url: string) { return { video_url: url, width: 1080, height: 1920, mode: "crop", codec: "libx264", preset: "fast", crf: 23 }; }
export function captionInput(url: string, language: string) {
  return { video_url: url, language, font_name: "Montserrat", font_size: 64, font_weight: "bold", highlight_color: "green", position: "bottom", y_offset: -260, words_per_subtitle: 3, enable_animation: false };
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