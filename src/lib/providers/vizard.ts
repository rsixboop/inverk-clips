// Vizard Open API — https://docs.vizard.ai/reference/submit , https://docs.vizard.ai/docs/retrieve-video-clips
import { ProviderError, providerFetch } from "./http";
const BASE = "https://elb-api.vizard.ai/hvizard-server-front/open-api/v1";
export const vizardConfigured = () => !!process.env["VIZARD_API_KEY"];
export type VizardClip = { videoId: string; url: string; durationS: number; title: string; transcript: string; viralScore: number; viralReason: string; editorUrl: string };

const CODES: Record<number, [string, boolean]> = {
  4001: ["Неверный ключ Vizard", false], 4002: ["Vizard: нарезка не удалась", false], 4003: ["Vizard: лимит запросов", true],
  4004: ["Vizard: неподдерживаемый формат видео", false], 4005: ["Vizard: неверная ссылка на видео", false], 4006: ["Vizard: недопустимый параметр", false],
  4007: ["Vizard: закончилось время на аккаунте", false], 4008: ["Vizard: не удалось скачать видео", false],
};
function codeError(code: number, j: any) {
  const [m, retry] = CODES[code] ?? [`Vizard код ${code}`, false];
  return new ProviderError(`${m}${j?.errMsg ? ` (${j.errMsg})` : ""}`, code, retry);
}
export function preferLength(seconds: number) { return seconds < 30 ? [1] : seconds <= 60 ? [2] : [3]; }
export function videoTypeFor(kind: string) { return kind === "youtube" ? 2 : kind === "twitch" ? 9 : 1; }

export function buildSubmit(o: { url: string; kind: string; lang: string; seconds: number; keywords: string; name: string; ext?: string }) {
  const type = videoTypeFor(o.kind);
  return { lang: o.lang, preferLength: preferLength(o.seconds), videoUrl: o.url, videoType: type, ratioOfClip: 1, subtitleSwitch: 1, headlineSwitch: 1,
    maxClipNumber: 5, keywords: o.keywords.slice(0, 200), projectName: o.name.slice(0, 80), ...(type === 1 ? { ext: o.ext ?? "mp4" } : {}) };
}
export function parseSubmit(j: any): string {
  if (j?.code === 2000 && j.projectId) return String(j.projectId);
  throw codeError(Number(j?.code), j);
}
export type VizardStatus = { state: "processing" } | { state: "done"; clips: VizardClip[] };
export function parseQuery(j: any): VizardStatus {
  const code = Number(j?.code);
  if (code === 1000) return { state: "processing" };
  if (code === 2000) {
    const clips = (Array.isArray(j.videos) ? j.videos : []).filter((v: any) => typeof v?.videoUrl === "string").map((v: any) => ({
      videoId: String(v.videoId), url: v.videoUrl, durationS: (Number(v.videoMsDuration) || 0) / 1000, title: String(v.title ?? ""),
      transcript: String(v.transcript ?? "").slice(0, 1500), viralScore: Number(v.viralScore) || 0, viralReason: String(v.viralReason ?? ""), editorUrl: String(v.clipEditorUrl ?? ""),
    }));
    return clips.length ? { state: "done", clips } : { state: "processing" };
  }
  throw codeError(code, j);
}
function headers() {
  const key = process.env["VIZARD_API_KEY"];
  if (!key) throw new ProviderError("Не подключено: VIZARD_API_KEY (ИИ-нарезка по ссылке)", 0, false);
  return { VIZARDAI_API_KEY: key, "content-type": "application/json" };
}
export async function vizardSubmit(body: ReturnType<typeof buildSubmit>) {
  return parseSubmit(await providerFetch("Vizard", `${BASE}/project/create`, { method: "POST", headers: headers(), body: JSON.stringify(body) }));
}
export async function vizardQuery(projectId: string) {
  return parseQuery(await providerFetch("Vizard", `${BASE}/project/query/${encodeURIComponent(projectId)}`, { headers: headers() }));
}
