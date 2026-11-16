export type ProviderErrorKind = "validation" | "no_media" | "forbidden" | "auth" | "credits" | "rate_limit" | "network" | "server" | "other";
/** Sanitized provider error detail: type/msg/loc only — never request inputs, headers or keys. */
export type ProviderDetail = { kind: ProviderErrorKind; status: number; types: string[]; messages: string[]; fields: string[] };
export class ProviderError extends Error {
  constructor(message: string, public status: number, public retryable: boolean, public ambiguous = false, public detail?: ProviderDetail) { super(message); }
  get kind(): ProviderErrorKind { return this.detail?.kind ?? "other"; }
}
const clip = (s: unknown, n = 240) => String(s ?? "").replace(/(Key|Bearer)\s+[\w.:-]+/gi, "$1 ***").slice(0, n);

/** Parse an error body (fal/FastAPI `detail[]`, `{error}`, plain text) into a sanitized, classified detail. */
export function classifyProviderError(status: number, text: string): ProviderDetail {
  let body: any = null; try { body = JSON.parse(text); } catch { /* plain text */ }
  const items: any[] = Array.isArray(body?.detail) ? body.detail : body?.detail ? [{ msg: body.detail }] : body?.error ? [{ msg: typeof body.error === "string" ? body.error : body.error?.message, type: body.error?.type }] : text ? [{ msg: text }] : [];
  const types = items.map((d) => clip(d?.type, 60)).filter(Boolean);
  const messages = items.map((d) => clip(d?.msg)).filter(Boolean).slice(0, 3);
  const fields = items.map((d) => (Array.isArray(d?.loc) ? d.loc.join(".") : "")).filter(Boolean).slice(0, 5);
  const all = `${types.join(" ")} ${messages.join(" ")}`;
  const kind: ProviderErrorKind =
    types.includes("no_media_generated") ? "no_media"
    : status === 402 || (status === 403 && /balance|credit|locked|exhausted|billing/i.test(all)) ? "credits"
    : status === 403 && /permission|access denied|not_priced|not available|forbidden/i.test(all) ? "forbidden"
    : status === 401 || status === 403 ? "auth"
    : status === 429 ? "rate_limit"
    : status === 422 || status === 400 ? "validation"
    : status >= 500 ? "server" : "other";
  return { kind, status, types, messages, fields };
}
export function humanProviderError(name: string, d: ProviderDetail) {
  const why = d.messages[0] ? ` Ответ: ${d.messages[0].slice(0, 160)}` : "";
  switch (d.kind) {
    case "no_media": return `${name}: модель не создала результат для этого запроса (no_media_generated, ${d.status}) — это не баланс; нужен изменённый запрос.`;
    case "credits": return `${name}: недостаточно средств на балансе — пополните счёт провайдера. Задача остановлена без повторов.`;
    case "forbidden": return `${name}: нет доступа к этому эндпоинту (403) — ключ рабочий, но аккаунту провайдера этот инструмент недоступен. Нужен доступ у провайдера или другой разрешённый инструмент; повтор не поможет.`;
    case "auth": return `${name}: ключ доступа отклонён (${d.status}). Проверьте ключ в настройках.`;
    case "rate_limit": return `${name}: слишком много запросов (429), повторю позже.`;
    case "validation": return `${name}: провайдер отклонил параметры запроса (${d.status}${d.fields.length ? `, поле ${d.fields.join(", ")}` : ""}).${why}`;
    case "server": return `${name}: временная ошибка сервиса (${d.status}).`;
    default: return `${name}: ошибка ${d.status}.${why}`;
  }
}
/** fetch with timeout; network failures are marked ambiguous (request may have reached provider). */
export async function providerFetch(name: string, url: string, init: RequestInit = {}, timeoutMs = 25000) {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new ProviderError(`${name}: сеть/таймаут`, 0, true, true, { kind: "network", status: 0, types: [], messages: [], fields: [] }); }
  const text = await r.text();
  if (!r.ok) {
    const d = classifyProviderError(r.status, text);
    const retryable = d.kind === "rate_limit" || d.kind === "server";
    throw new ProviderError(humanProviderError(name, d), r.status, retryable, init.method === "POST" && d.kind === "server", d);
  }
  try { return JSON.parse(text) as any; } catch { throw new ProviderError(`${name}: ответ не JSON`, r.status, false, init.method === "POST"); }
}
