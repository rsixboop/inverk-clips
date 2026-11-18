export type OverlayCue = {
  purpose: string; speech: string; start: number; action: number; after: number; end: number;
  before: string; active: string; result: string; box: [number, number, number, number];
  fill_region?: [number,number,number,number];
  /** "up" reveals the active state bottom→top (preload fill); default left→right. */
  fill_dir?: "right" | "up";
  /** Separate RGBA motion layers on the cue box; keys [secondsFromAfter, dx, dy, scale, alpha], box-relative. */
  layers?: { src: string; keys: [number,number,number,number,number][]; ease?: "settle" | "linear" }[];
};
const CASE_LOCK = "/overlay-library/clean-tech/case-lock";
export const BUILTIN_CASE_LOCK_KEY = "builtin:case-lock";
export const BUILTIN_CASE_LOCK_PATHS = ["before","active","result"].map(s => `${CASE_LOCK}/${s}.png`);
const CASE_LOCK_MOTION: Pick<OverlayCue,"box"|"fill_region"|"fill_dir"|"layers"> = {
  box: [0.03,0.08,0.58,0.367], fill_region: [0,0,1,1], fill_dir: "up",
  layers: [
    { src: `${CASE_LOCK}/lock-shackle.png`, keys: [[0,0,-0.3,1,0],[0.5,0,-0.085,1,1],[0.8,0,-0.085,1,1],[1.1,0,0,1,1]] },
    { src: `${CASE_LOCK}/lock-body.png`, keys: [[0,0,-0.215,1,0],[0.5,0,0,1,1],[1.1,0,0,1,1],[1.22,0,0.016,1,1],[1.42,0,0,1,1]] },
  ],
};
/** Adds the built-in case+padlock motion; keeps the lock on screen until it has settled. */
export function withBuiltinCaseLock(cue: OverlayCue, duration: number): OverlayCue | null {
  const end = Math.min(duration, Math.max(cue.end, cue.after + 1.6));
  if (cue.after + 1.42 > end) return null;
  return { ...cue, ...CASE_LOCK_MOTION, end };
}
export function settleEase(p: number) { const c = 1.9, q = p - 1; return 1 + (c+1)*q**3 + c*q**2; }
export function layerPose(layer: NonNullable<OverlayCue["layers"]>[number], rel: number): [number,number,number,number] {
  const k = layer.keys; const first = k[0]!;
  if (rel <= first[0]) return [first[1],first[2],first[3],first[4]];
  for (let i = 0; i < k.length-1; i++) {
    const a = k[i]!, b = k[i+1]!;
    if (rel < b[0]) {
      const p = (rel-a[0])/(b[0]-a[0]), e = layer.ease === "linear" ? p : settleEase(p);
      return [1,2,3,4].map(j => a[j]! + (b[j]!-a[j]!)*(j===4 ? p : e)) as [number,number,number,number];
    }
  }
  const last = k[k.length-1]!; return [last[1],last[2],last[3],last[4]];
}
export function isOverlayImageUrl(path: unknown, storageOrigin = import.meta.env['VITE_SUPABASE_URL']): path is string {
  if (typeof path !== "string") return false;
  if (/^\/overlay-library\/[\w/.-]+\.png$/.test(path) && !path.includes("..")) return true;
  try {
    const url = new URL(path), origin = new URL(storageOrigin);
    return url.protocol === "https:" && url.origin === origin.origin && !url.username && !url.password &&
      /^\/storage\/v1\/object\/sign\/outputs\/[\w/-]+\.png$/.test(url.pathname) && Boolean(url.searchParams.get("token"));
  } catch { return false; }
}
export function validateOverlayCues(input: unknown, duration: number, storageOrigin = import.meta.env['VITE_SUPABASE_URL']): OverlayCue[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error("Оверлеи должны быть списком");
  return input.map((c) => {
    if (!c || typeof c.purpose !== "string" || !c.purpose.trim() || typeof c.speech !== "string" || !c.speech.trim()) throw new Error("Нужны цель и фраза озвучки");
    if (![c.start,c.action,c.after,c.end].every(Number.isFinite) || !(0 <= c.start && c.start < c.action && c.action < c.after && c.after < c.end && c.end <= duration)) throw new Error("Время: начало < действие < результат < конец в пределах озвучки");
    if (![c.before,c.active,c.result].every((p) => isOverlayImageUrl(p, storageOrigin))) throw new Error("Нужны три PNG из библиотеки или защищённого хранилища");
    const b = c.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || b[2] <= 0 || b[3] <= 0 || b[0]+b[2]>1 || b[1]+b[3]>1) throw new Error("Объект должен помещаться в кадр");
    if(c.fill_region && (!Array.isArray(c.fill_region) || c.fill_region.length!==4 || !c.fill_region.every((v:number)=>Number.isFinite(v)&&v>=0&&v<=1) || c.fill_region[0]>=c.fill_region[2] || c.fill_region[1]>=c.fill_region[3])) throw new Error("Некорректная область заполнения");
    if (c.fill_dir !== undefined && c.fill_dir !== "right" && c.fill_dir !== "up") throw new Error("Некорректное направление заполнения");
    if (c.layers !== undefined) {
      if (!Array.isArray(c.layers) || c.layers.length > 4) throw new Error("Слои движения: до 4");
      for (const l of c.layers) {
        if (!l || !isOverlayImageUrl(l.src, storageOrigin) || !Array.isArray(l.keys) || l.keys.length < 1 || l.keys.length > 12 ||
          !l.keys.every((k: unknown) => Array.isArray(k) && k.length === 5 && k.every(Number.isFinite)) ||
          l.keys.some((k: number[], i: number) => i > 0 && k[0]! <= l.keys[i-1][0]) || c.after + l.keys[l.keys.length-1][0] > c.end)
          throw new Error("Слой движения: PNG и упорядоченные ключи, завершение до конца объекта");
      }
    }
    return c as OverlayCue;
  });
}
export function overlayState(c: OverlayCue, time: number) {
  if (time < c.start || time >= c.end) return null;
  if (time < c.action) return { name: "before" as const, progress: 0 };
  if (time < c.after) return { name: "active" as const, progress: (time-c.action)/(c.after-c.action) };
  return { name: "result" as const, progress: 1 };
}
export async function loadOverlayImages(cues: OverlayCue[]) {
  const images = new Map<string, HTMLImageElement>();
  await Promise.all([...new Set(cues.flatMap(c => [c.before,c.active,c.result,...(c.layers ?? []).map(l => l.src)]))].map(async path => {
    const im = new Image(); im.crossOrigin="anonymous"; im.src = path; await im.decode();
    const canvas = document.createElement("canvas"); canvas.width = im.width; canvas.height = im.height;
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Canvas unavailable");
    ctx.drawImage(im,0,0); const pixels = ctx.getImageData(0,0,im.width,im.height).data;
    if (!pixels.some((v,i) => i%4===3 && v<255)) throw new Error("PNG не имеет прозрачности");
    images.set(path, im);
  }));
  return images;
}
export function drawOverlayCues(ctx: CanvasRenderingContext2D, cues: OverlayCue[], images: Map<string, HTMLImageElement>, time: number) {
  for (const c of cues) {
    const state = overlayState(c,time); if (!state) continue;
    const [bx,by,bw,bh] = c.box;
    const x=bx*ctx.canvas.width, y=by*ctx.canvas.height, w=bw*ctx.canvas.width, h=bh*ctx.canvas.height;
    const image=images.get(c[state.name]); if (!image) throw new Error("Объект не загружен");
    if (state.name === "active" && c.fill_region) {
      const before=images.get(c.before); if (before) ctx.drawImage(before,x,y,w,h);
      const [l,t,r,b]=c.fill_region ?? [0,0,1,1];
      ctx.save(); ctx.beginPath();
      if (c.fill_dir === "up") { const fh=(b-t)*h*state.progress; ctx.rect(x+l*w,y+b*h-fh,(r-l)*w,fh); }
      else ctx.rect(x+l*w,y+t*h,(r-l)*w*state.progress,(b-t)*h);
      ctx.clip(); ctx.drawImage(image,x,y,w,h); ctx.restore();
    } else ctx.drawImage(image,x,y,w,h);
    for (const layer of c.layers ?? []) {
      const [dx,dy,scale,alpha] = layerPose(layer, time - c.after); if (alpha <= 0.01) continue;
      const im = images.get(layer.src); if (!im) throw new Error("Слой не загружен");
      const lw=w*scale, lh=h*scale;
      ctx.save(); ctx.globalAlpha = Math.min(1,alpha); ctx.drawImage(im, x+dx*w+(w-lw)/2, y+dy*h+(h-lh)/2, lw, lh); ctx.restore();
    }
  }
}