// Official schemas: https://www.atlascloud.ai/docs/openapi-index.md and /docs/predictions.md
import { ProviderError, providerFetch } from "./http";
import { providerMedia } from "./fal";
const BASE = "https://api.atlascloud.ai/api/v1/model";
export const ATLAS_TTS = "google/gemini-2.5-flash-tts";
export const ATLAS_IMAGE = "google/nano-banana-2-lite/text-to-image";
export const atlasConfigured = () => Boolean(process.env["ATLAS_CLOUD_API_KEY"]);
function headers() {
  const key = process.env["ATLAS_CLOUD_API_KEY"];
  if (!key) throw new ProviderError("Не подключено: ATLAS_CLOUD_API_KEY", 0, false);
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
export function ttsInput(script: string) {
  if (!script.trim()) throw new Error("Нет текста для озвучки");
  return { model: ATLAS_TTS, text: script, voice: "Kore" };
}
export function imageInput(prompt: string) { return { model: ATLAS_IMAGE, prompt, aspect_ratio: "9:16", resolution: "1k", enable_sync_mode: false }; }
export async function atlasSubmit(model: string, input: Record<string, unknown>): Promise<string> {
  if (![ATLAS_TTS, ATLAS_IMAGE].includes(model)) throw new Error("Неподдерживаемая модель Atlas Cloud");
  const j = await providerFetch("Atlas Cloud", `${BASE}/${model === ATLAS_TTS ? "generateAudio" : "generateImage"}`, { method: "POST", headers: headers(), body: JSON.stringify({ ...input, model }) });
  const d = j.data ?? j;
  if (typeof d.id !== "string" || !d.id) throw new ProviderError("Atlas Cloud: не получен ID; исход отправки неизвестен", 0, false, true);
  return d.id;
}
export function parsePrediction(j: any): { state: "processing" } | { state: "done"; result: { url: string } } {
  const d = j.data ?? j;
  if (["created", "pending", "queued", "processing", "starting"].includes(d.status)) return { state: "processing" };
  if (["failed", "cancelled"].includes(d.status)) throw new ProviderError("Atlas Cloud: генерация не удалась; проверьте запрос и баланс в кабинете", 0, false);
  if (d.status !== "completed") throw new ProviderError("Atlas Cloud: неизвестный статус", 0, false);
  return { state: "done", result: { url: providerMedia(d.outputs?.[0]) } };
}
export async function atlasPoll(_model: string, id: string) {
  return parsePrediction(await providerFetch("Atlas Cloud", `${BASE}/prediction/${encodeURIComponent(id)}`, { headers: headers() }));
}