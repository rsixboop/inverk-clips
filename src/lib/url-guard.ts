// SSRF guard + source classification. Pure functions (unit-tested) plus DNS check via DoH.
export type SourceClass = "direct_url" | "youtube" | "twitch" | "channel" | "page";

const YT = /(^|\.)(youtube\.com|youtu\.be)$/i;
const TW = /(^|\.)twitch\.tv$/i;

export function parsePublicUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error("Некорректная ссылка"); }
  if (u.protocol !== "https:") throw new Error("Разрешены только https-ссылки");
  if (u.username || u.password) throw new Error("Ссылки с логином/паролем запрещены");
  if (u.port && u.port !== "443") throw new Error("Нестандартный порт запрещён");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes("."))
    throw new Error("Локальные адреса запрещены");
  if (isIpLiteral(h) && isPrivateIp(h.replace(/^\[|\]$/g, ""))) throw new Error("Приватные IP-адреса запрещены");
  return u;
}

export function classifyUrl(u: URL): SourceClass {
  const h = u.hostname;
  if (YT.test(h)) return /\/(channel|c|@|user)/.test(u.pathname) || u.pathname.startsWith("/@") ? "channel" : "youtube";
  if (TW.test(h)) return /^\/videos\/\d+/.test(u.pathname) ? "twitch" : "channel";
  if (/\.(mp4|m4v|mov)$/i.test(u.pathname)) return "direct_url";
  return "page";
}

export function isIpLiteral(h: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && (b === 18 || b === 19));
}

export async function assertPublicDns(host: string) {
  if (isIpLiteral(host)) return;
  for (const type of ["A", "AAAA"]) {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    });
    if (!r.ok) throw new Error("Не удалось проверить DNS");
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    for (const a of j.Answer ?? []) if ((a.type === 1 || a.type === 28) && isPrivateIp(a.data)) throw new Error("Хост указывает на приватную сеть");
  }
}

export const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

/** HEAD-check a direct video URL without following redirects to unvalidated hosts. */
export async function inspectDirectVideo(raw: string) {
  let u = parsePublicUrl(raw);
  for (let hop = 0; hop < 3; hop++) {
    await assertPublicDns(u.hostname);
    const r = await fetch(u.toString(), { method: "HEAD", redirect: "manual" });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      u = parsePublicUrl(new URL(r.headers.get("location")!, u).toString());
      continue;
    }
    if (!r.ok) throw new Error(`Источник ответил ${r.status}`);
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
    const len = Number(r.headers.get("content-length") ?? 0);
    if (!/^video\/(mp4|quicktime)$/.test(type) && type !== "application/octet-stream")
      throw new Error(`Это не видеофайл (тип: ${type || "неизвестен"}). Нужна прямая ссылка на MP4.`);
    if (len > MAX_SOURCE_BYTES) throw new Error("Файл больше 500 МБ");
    return { url: u.toString(), mime: type, bytes: len || null };
  }
  throw new Error("Слишком много перенаправлений");
}
