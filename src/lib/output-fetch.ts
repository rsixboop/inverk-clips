// Guarded download of provider outputs: https only, public DNS on every redirect hop, provider host
// allowlist for fal.ai, streamed byte cap and overall timeout (Workers have ~128 MB memory).
import { assertPublicDns, parsePublicUrl } from "@/lib/url-guard";
import { ProviderError } from "@/lib/providers/http";

export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const FAL_HOSTS = [/(^|\.)fal\.media$/i];
export function allowedOutputHost(_route: string, host: string) {
  return FAL_HOSTS.some((r) => r.test(host));
}

export async function fetchOutput(raw: string, route: string, o: { fetchImpl?: typeof fetch; dns?: (h: string) => Promise<void>; maxBytes?: number; timeoutMs?: number } = {}) {
  const f = o.fetchImpl ?? fetch, dns = o.dns ?? assertPublicDns, max = o.maxBytes ?? MAX_OUTPUT_BYTES;
  const signal = AbortSignal.timeout(o.timeoutMs ?? 50_000);
  let u = parsePublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    if (!allowedOutputHost(route, u.hostname)) throw new Error(`Хост результата не разрешён: ${u.hostname}`);
    await dns(u.hostname);
    let r: Response;
    try { r = await f(u.toString(), { redirect: "manual", signal }); }
    catch { throw new ProviderError(`Скачивание результата: сеть/таймаут`, 0, true, true); }
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { u = parsePublicUrl(new URL(loc, u).toString()); continue; }
    if (!r.ok || !r.body) throw new ProviderError(`Не удалось скачать результат: ${r.status}`, r.status, r.status >= 500 || r.status === 429);
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len > max) throw new Error(`Результат слишком большой (${len} байт > ${max})`);
    const reader = r.body.getReader();
    const parts: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel(); throw new Error(`Результат превысил лимит ${max} байт`); }
      parts.push(value);
    }
    const out = new Uint8Array(total); let p = 0;
    for (const c of parts) { out.set(c, p); p += c.byteLength; }
    return out;
  }
  throw new Error("Слишком много перенаправлений при скачивании результата");
}
