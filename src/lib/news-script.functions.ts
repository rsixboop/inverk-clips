import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { htmlToText, isNewswireUrl, validateScript } from "@/lib/news-article";

export const findNewswire = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async () => {
  const { tavilyConfigured, tavilySearch } = await import("@/lib/providers/tavily");
  if (!tavilyConfigured()) return { error: "Поиск не подключён (TAVILY_API_KEY). Вставьте прямую ссылку на статью Rockstar Newswire.", items: [] };
  try {
    const hits = await tavilySearch("site:rockstargames.com/newswire Grand Theft Auto VI", 8);
    const items = hits.filter((h) => isNewswireUrl(h.url)).slice(0, 5).map((h) => ({ title: h.title, url: h.url, date: (h.snippet.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w* \d{1,2}, \d{4}\b/) ?? [""])[0] }));
    return { error: items.length ? "" : "Официальных статей Newswire не найдено. Вставьте ссылку вручную.", items };
  } catch (e) { return { error: `Ошибка поиска: ${(e as Error).message}`, items: [] }; }
});

export const scriptFromArticle = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ url: z.string().max(300).refine(isNewswireUrl, "Только https://www.rockstargames.com/newswire/article/…") }).parse(d))
  .handler(async ({ data }) => {
    const res = await fetch(data.url, { redirect: "manual", signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 InverkClips" } });
    if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`Статья не прочитана (HTTP ${res.status}) — сценарий не создан`);
    const reader = res.body!.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > 3_000_000) { await reader.cancel(); throw new Error("Статья слишком большая"); } chunks.push(value); }
    const html = new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
    const text = htmlToText(html).slice(0, 20000);
    if (!/grand theft auto vi|gta vi/i.test(text) || text.length < 400) throw new Error("В статье не найден текст о GTA VI — сценарий не создан");
    const { generateResponse } = await import("@lovable.dev/ai-gateway");
    const r: any = await generateResponse({ model: "openai/gpt-6-astra",
      instructions: "You are a GTA VI news editor. Use ONLY facts from the article. First list 3 possible angles and score each 1-5 on novelty, usefulness to the viewer and visual provability; pick the best. If no angle scores >=3 on novelty and usefulness, return {\"reject\":true,\"reason\":\"...\"}. Never invent sensations. Otherwise write a 4-shot English TikTok script (hook, fact, fact, question). Per shot: text = narration (<=110 chars); caption = short on-screen label (<=40 chars, separate from narration); fact = EXACT verbatim quote (12-160 chars) from the article; brief = concrete visual (<=160 chars, e.g. 'official screenshot of Vice City skyline'); role = 'evidence' only if the visual itself proves the fact (e.g. screenshot of the article), else 'illustration'. JSON: {\"angles\":[{\"angle\":\"\",\"score\":0}],\"angle\":\"\",\"shots\":[{\"text\":\"\",\"caption\":\"\",\"fact\":\"\",\"brief\":\"\",\"role\":\"illustration\"}]}",
      input: [{ role: "user", content: `ARTICLE:\n${text}\nReturn JSON.` }], text: { format: { type: "json_object" } } } as any);
    let out: string | undefined = r?.output_text;
    if (!out) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") out = x.text;
    let j: any; try { j = JSON.parse(out ?? ""); } catch { throw new Error("ИИ вернул некорректный ответ"); }
    return { url: data.url, ...validateScript(j, text) };
  });

// Broad recent GTA VI news (any site). Non-official sources are flagged; nothing is generated from snippets.
export const findGtaNews = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async () => {
  const { tavilyConfigured, tavilySearch } = await import("@/lib/providers/tavily");
  if (!tavilyConfigured()) return { error: "Поиск не подключён: нет TAVILY_API_KEY. Пилот сохранён, можно вставить ссылку вручную.", items: [] };
  try {
    const hits = await tavilySearch("GTA VI Grand Theft Auto 6 news", 6, { days: 7 });
    return { error: hits.length ? "" : "За последние дни ничего не найдено.", items: hits.slice(0, 6).map((h) => ({ title: h.title, url: h.url, snippet: h.snippet.slice(0, 220), date: h.date ?? "", official: isNewswireUrl(h.url) })) };
  } catch (e) { return { error: `Ошибка поиска: ${(e as Error).message}`, items: [] }; }
});
