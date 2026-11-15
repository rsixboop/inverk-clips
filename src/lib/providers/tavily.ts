// Tavily Search API — https://docs.tavily.com/documentation/api-reference/endpoint/search
import { ProviderError, providerFetch } from "./http";
export type ResearchHit = { title: string; url: string; snippet: string; score: number };
export const tavilyConfigured = () => !!process.env["TAVILY_API_KEY"];

export function parseTavily(j: any): ResearchHit[] {
  return (Array.isArray(j?.results) ? j.results : [])
    .filter((r: any) => typeof r?.url === "string" && /^https?:\/\//.test(r.url))
    .map((r: any) => ({ title: String(r.title ?? ""), url: r.url, snippet: String(r.content ?? "").slice(0, 600), score: Number(r.score) || 0 }));
}
export async function tavilySearch(query: string, max = 6): Promise<ResearchHit[]> {
  const key = process.env["TAVILY_API_KEY"];
  if (!key) throw new ProviderError("Не подключено: TAVILY_API_KEY (веб-поиск фактов)", 0, false);
  const j = await providerFetch("Tavily", "https://api.tavily.com/search", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ query: query.slice(0, 380), search_depth: "basic", max_results: max, include_answer: false }),
  });
  return parseTavily(j);
}
