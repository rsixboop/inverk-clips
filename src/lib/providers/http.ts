export class ProviderError extends Error {
  constructor(message: string, public status: number, public retryable: boolean, public ambiguous = false) { super(message); }
}
/** fetch with timeout; network failures are marked ambiguous (request may have reached provider). */
export async function providerFetch(name: string, url: string, init: RequestInit = {}, timeoutMs = 25000) {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new ProviderError(`${name}: сеть/таймаут`, 0, true, true); }
  const text = await r.text();
  if (r.status === 402 || (r.status === 403 && /balance|credit|locked|exhausted|billing/i.test(text)))
    throw new ProviderError(`${name}: недостаточно средств на балансе — пополните счёт провайдера. Задача остановлена без повторов.`, r.status, false, false);
  if (!r.ok) throw new ProviderError(`${name}: ошибка ${r.status}. Проверьте доступ и баланс сервиса.`, r.status, r.status === 429 || r.status >= 500, init.method === "POST" && r.status >= 500);
  try { return JSON.parse(text) as any; } catch { throw new ProviderError(`${name}: ответ не JSON`, r.status, false, init.method === "POST"); }
}
