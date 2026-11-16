// Pure helpers for the GTA VI News script flow (client-safe).
export const isNewswireUrl = (u: string) => /^https:\/\/www\.rockstargames\.com\/newswire\/article\/[\w-]+(\/[\w-]+)?\/?$/.test(u.trim());
export const htmlToText = (h: string) => h.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
export type ScriptShot = { text: string; fact: string; seconds: number };
// Every shot must quote a fact that literally appears in the article; otherwise the script is rejected.
export function validateScript(shots: unknown, article: string): ScriptShot[] {
  if (!Array.isArray(shots) || shots.length !== 4) throw new Error("ИИ вернул не 4 шота");
  const a = norm(article);
  return shots.map((s: any, i) => {
    const text = String(s?.text ?? "").trim(), fact = String(s?.fact ?? "").trim();
    if (!text || text.length > 140) throw new Error(`Шот ${i + 1}: некорректный текст`);
    if (fact.length < 12 || !a.includes(norm(fact))) throw new Error(`Шот ${i + 1}: факт не найден в статье — сценарий отклонён`);
    return { text, fact, seconds: [4, 6, 6, 5][i]! };
  });
}
