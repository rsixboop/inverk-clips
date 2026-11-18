export type OverlayCue = {
  purpose: string; speech: string; start: number; action: number; after: number; end: number;
  before: string; active: string; result: string; box: [number, number, number, number];
  fill_region?: [number,number,number,number];
};
// Only choose a cached object when the spoken line actually explains its change.
// Other topics default to zero; never add a decorative object to fill a quota.
export function suggestOverlayCues(text: string, seconds: number): OverlayCue[] {
  if (!/download|preload/i.test(text) || !/not|doesn.t|≠/i.test(text) || !/early|access|play/i.test(text) || seconds < 2) return [];
  const path="/overlay-library/clean-tech/300b6a9bc7ed8b4/";
  return [{ purpose:"Downloading does not grant early access", speech:text, start:0,
    action:seconds*0.15, after:seconds*0.62, end:seconds,
    before:path+"before.png",active:path+"active.png",result:path+"result.png",box:[0,0.86,1,0.14],fill_region:[0.108,0.455,0.85,0.67] }];
}
export function validateOverlayCues(input: unknown, duration: number): OverlayCue[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error("Оверлеи должны быть списком");
  return input.map((c) => {
    if (!c || typeof c.purpose !== "string" || !c.purpose.trim() || typeof c.speech !== "string" || !c.speech.trim()) throw new Error("Нужны цель и фраза озвучки");
    if (![c.start,c.action,c.after,c.end].every(Number.isFinite) || !(0 <= c.start && c.start < c.action && c.action < c.after && c.after < c.end && c.end <= duration)) throw new Error("Время: начало < действие < результат < конец в пределах озвучки");
    if (![c.before,c.active,c.result].every((p) => typeof p === "string" && /^\/overlay-library\/[\w/.-]+\.png$/.test(p) && !p.includes(".."))) throw new Error("Нужны три PNG из библиотеки");
    const b = c.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || b[2] <= 0 || b[3] <= 0 || b[0]+b[2]>1 || b[1]+b[3]>1) throw new Error("Объект должен помещаться в кадр");
    if(c.fill_region && (!Array.isArray(c.fill_region) || c.fill_region.length!==4 || !c.fill_region.every((v:number)=>Number.isFinite(v)&&v>=0&&v<=1) || c.fill_region[0]>=c.fill_region[2] || c.fill_region[1]>=c.fill_region[3])) throw new Error("Некорректная область заполнения");
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
  await Promise.all([...new Set(cues.flatMap(c => [c.before,c.active,c.result]))].map(async path => {
    const im = new Image(); im.src = path; await im.decode();
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
    if (state.name === "active") {
      const before=images.get(c.before); if (before) ctx.drawImage(before,x,y,w,h);
      const [l,t,r,b]=c.fill_region ?? [0,0,1,1];
      ctx.save(); ctx.beginPath(); ctx.rect(x+l*w,y+t*h,(r-l)*w*state.progress,(b-t)*h); ctx.clip(); ctx.drawImage(image,x,y,w,h); ctx.restore();
    } else ctx.drawImage(image,x,y,w,h);
  }
}