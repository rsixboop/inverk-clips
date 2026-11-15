// Shotstack Edit API adapter (https://shotstack.io/docs). Pure edit builder + thin HTTP calls.
export type RenderInput = {
  videoUrl: string;
  clipStart: number;
  clipLength: number;
  audioMode: "voiceover" | "original";
  script: string;
  language: "en" | "ru" | "uk";
  callbackUrl?: string;
};

const VOICE: Record<RenderInput["language"], string> = { en: "Brian", ru: "Daniel", uk: "Daniel" };

export function buildEdit(i: RenderInput) {
  const len = Math.max(3, Math.round(i.clipLength * 10) / 10);
  const vo = i.audioMode === "voiceover";
  const caption = {
    asset: {
      type: "rich-caption",
      src: vo ? "alias://voiceover" : "alias://footage",
      font: { size: 64, color: "#ffffff", weight: 800 },
      stroke: { width: 4, color: "#000000", opacity: 1 },
      active: { font: { color: "#c6ff3d" } },
      animation: { style: "highlight" },
    },
    start: 0,
    length: "end",
    position: "bottom",
    offset: { y: 0.2 }, // keep clear of TikTok bottom UI
  };
  const tracks: unknown[] = [{ clips: [caption] }];
  if (vo) {
    tracks.push({
      clips: [{
        alias: "voiceover",
        asset: { type: "audio", prompt: i.script, model: "elevenlabs-multilingual-v2", options: { voice: VOICE[i.language], language: i.language } },
        start: 0,
        length: "auto",
      }],
    });
  }
  tracks.push({
    clips: [{
      alias: "footage",
      asset: { type: "video", src: i.videoUrl, trim: Math.max(0, i.clipStart), volume: vo ? 0.12 : 1 },
      start: 0,
      length: len,
      fit: "crop", // fill 9:16, centre crop
    }],
  });
  return {
    timeline: { background: "#000000", tracks },
    output: { format: "mp4", size: { width: 1080, height: 1920 }, fps: 30 },
    ...(i.callbackUrl ? { callback: i.callbackUrl } : {}),
  };
}

export class ProviderError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) { super(message); }
}

function cfg() {
  const key = process.env["SHOTSTACK_API_KEY"];
  const env = process.env["SHOTSTACK_ENV"] === "v1" ? "v1" : "stage";
  return { key, env, base: `https://api.shotstack.io/edit/${env}` };
}
export function shotstackConfigured() { return !!cfg().key; }
export function shotstackEnv() { return cfg().env; }

async function call(path: string, init?: RequestInit) {
  const { key, base } = cfg();
  if (!key) throw new ProviderError("Не подключено: добавьте секрет SHOTSTACK_API_KEY", 0, false);
  let r: Response;
  try {
    r = await fetch(base + path, { ...init, headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    throw new ProviderError(`Сеть/таймаут Shotstack: ${(e as Error).message}`, 0, true);
  }
  const text = await r.text();
  if (!r.ok) throw new ProviderError(`Shotstack ${r.status}: ${text.slice(0, 300)}`, r.status, r.status === 429 || r.status >= 500);
  return JSON.parse(text) as { response: Record<string, any> };
}

export async function probe(url: string): Promise<number | null> {
  const j = await call(`/probe/${encodeURIComponent(url)}`);
  const d = Number(j.response?.metadata?.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : null;
}
export async function submitRender(edit: unknown): Promise<string> {
  const j = await call("/render", { method: "POST", body: JSON.stringify(edit) });
  const id = j.response?.id;
  if (!id) throw new ProviderError("Shotstack не вернул id рендера", 0, false);
  return id;
}
export async function getRender(id: string) {
  const j = await call(`/render/${encodeURIComponent(id)}`);
  return { status: String(j.response?.status), url: j.response?.url as string | undefined, error: j.response?.error as string | undefined };
}
