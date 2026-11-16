import { createFileRoute } from "@tanstack/react-router";
import { assetUrl, findAsset } from "@/lib/news-catalog";

const MAX = 15 * 1024 * 1024;
export const Route = createFileRoute("/api/rockstar-media/$id")({
  server: { handlers: { GET: async ({ params }) => {
    const a = findAsset(params.id);
    if (!a) return new Response("Неизвестный ID", { status: 404 });
    let r: Response;
    try { r = await fetch(assetUrl(a), { signal: AbortSignal.timeout(15_000) }); }
    catch { return new Response("Rockstar: сеть/таймаут", { status: 504 }); }
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok || !r.body) return new Response(`Rockstar: ошибка ${r.status}`, { status: 502 });
    if (!type.startsWith("image/")) return new Response("Rockstar вернул не изображение", { status: 502 });
    if (Number(r.headers.get("content-length") ?? 0) > MAX) return new Response("Файл слишком большой", { status: 502 });
    const reader = r.body.getReader(); const parts: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.byteLength;
      if (n > MAX) { await reader.cancel(); return new Response("Файл слишком большой", { status: 502 }); } parts.push(value); }
    const out = new Uint8Array(n); let p = 0; for (const c of parts) { out.set(c, p); p += c.byteLength; }
    return new Response(out, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
  } } },
});
