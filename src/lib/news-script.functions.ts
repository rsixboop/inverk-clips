import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isNewswireUrl } from "@/lib/news-article";
import { builtinOverlayAssets } from "./news-overlay-plan";

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
  .inputValidator((d) => z.object({ url: z.string().max(300).refine(isNewswireUrl, "Только https://www.rockstargames.com/newswire/article/…"),language:z.enum(["EN","RU","UK"]).default("EN") }).parse(d))
  .handler(async ({ data,context }) => {
    const {data:cache}=await context.supabase.from("news_overlay_assets").select("asset_key,state").eq("user_id",context.userId).limit(40);
    const catalog=(cache ?? []).flatMap(row=>{const state=row.state as {step?:number;intent?:unknown};return state.step===6?[{key:row.asset_key,intent:state.intent}]:[];});
    const { buildScriptFromArticle } = await import("@/lib/news-script.server"); return buildScriptFromArticle(data.url,data.language,[...builtinOverlayAssets,...catalog]);
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
