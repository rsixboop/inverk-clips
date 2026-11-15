// Shotstack Edit API — https://shotstack.io/docs/guide/ (speech: "AI Speech Generation" guide;
// model elevenlabs-multilingual-v2 + voices Brian/Daniel are listed in the official voice table).
import { ProviderError, providerFetch } from "./providers/http";
export { ProviderError };

export type Segment = { url: string; trim: number; length: number };
export type RenderInput = {
  segments: Segment[];
  audioMode: "voiceover" | "original";
  script: string;
  language: "en" | "ru" | "uk";
  callbackUrl?: string | undefined;
};
const VOICE: Record<RenderInput["language"], string> = { en: "Brian", ru: "Daniel", uk: "Daniel" };

export function buildEdit(i: RenderInput) {
  if (!i.segments.length) throw new Error("Нет футажа для сборки");
  const vo = i.audioMode === "voiceover";
  const caption = {
    asset: { type: "rich-caption", src: vo ? "alias://voiceover" : "alias://footage0", font: { size: 64, color: "#ffffff", weight: 800 },
      stroke: { width: 4, color: "#000000", opacity: 1 }, active: { font: { color: "#c6ff3d" } }, animation: { style: "highlight" } },
    start: 0, length: "end", position: "bottom", offset: { y: 0.2 },
  };
  let t = 0;
  const footage = i.segments.map((s, n) => {
    const last = n === i.segments.length - 1;
    const clip = {
      alias: `footage${n}`,
      asset: { type: "video", src: s.url, trim: Math.max(0, Math.round(s.trim * 10) / 10), volume: vo ? 0 : 1 },
      start: Math.round(t * 100) / 100,
      // with voiceover the final clip stretches to the timeline end (= speech end), so no black tail
      length: vo && last ? "end" : Math.max(1, Math.round(s.length * 10) / 10),
      fit: "crop",
    };
    t += s.length;
    return clip;
  });
  const tracks: unknown[] = [{ clips: [caption] }];
  if (vo) tracks.push({ clips: [{ alias: "voiceover", asset: { type: "audio", prompt: i.script, model: "elevenlabs-multilingual-v2", options: { voice: VOICE[i.language], language: i.language } }, start: 0, length: "auto" }] });
  tracks.push({ clips: footage });
  return {
    timeline: { background: "#000000", tracks },
    output: { format: "mp4", size: { width: 1080, height: 1920 }, fps: 30 },
    ...(i.callbackUrl ? { callback: i.callbackUrl } : {}),
  };
}

function cfg() {
  const env = process.env["SHOTSTACK_ENV"] === "v1" ? "v1" : "stage";
  return { key: process.env["SHOTSTACK_API_KEY"], env, base: `https://api.shotstack.io/edit/${env}` };
}
export const shotstackConfigured = () => !!cfg().key;
export const shotstackEnv = () => cfg().env;
function h() {
  const { key } = cfg();
  if (!key) throw new ProviderError("Не подключено: SHOTSTACK_API_KEY (сборка, озвучка, субтитры)", 0, false);
  return { "x-api-key": key, "content-type": "application/json", accept: "application/json" };
}
export async function probe(url: string): Promise<number | null> {
  const j = await providerFetch("Shotstack", `${cfg().base}/probe/${encodeURIComponent(url)}`, { headers: h() });
  const d = Number(j.response?.metadata?.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}
export async function submitRender(edit: unknown): Promise<string> {
  const j = await providerFetch("Shotstack", `${cfg().base}/render`, { method: "POST", headers: h(), body: JSON.stringify(edit) });
  if (!j.response?.id) throw new ProviderError("Shotstack не вернул id рендера", 0, false);
  return String(j.response.id);
}
export async function getRender(id: string) {
  const j = await providerFetch("Shotstack", `${cfg().base}/render/${encodeURIComponent(id)}`, { headers: h() });
  return { status: String(j.response?.status), url: j.response?.url as string | undefined, error: j.response?.error as string | undefined };
}
