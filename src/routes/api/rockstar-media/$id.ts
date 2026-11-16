import { createFileRoute } from "@tanstack/react-router";
import { assetUrl, clipUrl, findAsset, findClip } from "@/lib/news-catalog";

const IMG_MAX = 15 * 1024 * 1024, VID_MAX = 20 * 1024 * 1024;
export const Route = createFileRoute("/api/rockstar-media/$id")({
  server: { handlers: { GET: async ({ params }) => {
    const a = findAsset(params.id), c = findClip(params.id);
    if (!a && !c) return new Response("Неизвестный ID", { status: 404 });
    const MAX = c ? VID_MAX : IMG_MAX, kind = c ? "video/" : "image/";
    let r: Response;
    try { r = await fetch(c ? clipUrl(c) : assetUrl(a!), { signal: AbortSignal.timeout(c ? 30_000 : 15_000) }); }
    catch { return new Response("Rockstar: сеть/таймаут", { status: 504 }); }
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok || !r.body) return new Response(`Rockstar: ошибка ${r.status}`, { status: 502 });
    if (!type.startsWith(kind)) return new Response(c ? "Rockstar вернул не видео" : "Rockstar вернул не изображение", { status: 502 });
    if (Number(r.headers.get("content-length") ?? 0) > MAX) return new Response("Файл слишком большой", { status: 502 });
    const reader = r.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.byteLength;
      if (n > MAX) { await reader.cancel(); return new Response("Файл слишком большой", { status: 502 }); } parts.push(value); }
    const out = new Uint8Array(n); let p = 0; for (const c of parts) { out.set(c, p); p += c.byteLength; }
    return new Response(out, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
  } } },
});
