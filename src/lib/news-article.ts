// Pure helpers for the GTA VI News script flow (client-safe).
import { validateOverlayCues, type OverlayCue } from "./news-overlays";
import { validateOverlayIntents, type OverlayIntent } from "./news-overlay-plan";
export const isNewswireUrl = (u: string) => /^https:\/\/www\.rockstargames\.com\/newswire\/article\/[\w-]+(\/[\w-]+)?\/?$/.test(u.trim());
export const htmlToText = (h: string) => h.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
export type ScriptShot = { text: string; caption: string; fact: string; brief: string; role: "evidence" | "illustration"; seconds: number; overlay_cues?: OverlayCue[]; overlay_intents?: OverlayIntent[]; overlay_warnings?: string[] };
export type ScriptResult = { angle: string; shots: ScriptShot[] };
// Model picks the most substantive of 3 angles or rejects a weak article. Every shot must quote a fact verbatim from the article.
export function validateScript(out: unknown, article: string): ScriptResult {
  const o = (out ?? {}) as any;
  if (o.reject) throw new Error(`Статья отклонена: ${String(o.reason ?? "мало содержательных фактов").slice(0, 200)}`);
  const angle = String(o.angle ?? "").trim();
  if (!angle || angle.length > 200) throw new Error("ИИ не выбрал угол подачи");
  const shots = o.shots;
  if (!Array.isArray(shots) || shots.length !== 4) throw new Error("ИИ вернул не 4 шота");
  const a = norm(article);
  return { angle, shots: shots.map((s: any, i) => {
    const text = String(s?.text ?? "").trim(), fact = String(s?.fact ?? "").trim();
    const caption = String(s?.caption ?? "").trim(), brief = String(s?.brief ?? "").trim();
    if (!text || text.length > 140) throw new Error(`Шот ${i + 1}: некорректный текст`);
    // A missing caption is intentional: showing the visual without a teaser is often better.
    if (caption.length > 48) throw new Error(`Шот ${i + 1}: слишком длинная подпись`);
    if (!brief || brief.length > 200) throw new Error(`Шот ${i + 1}: нет visual brief`);
    if (s?.role !== "evidence" && s?.role !== "illustration") throw new Error(`Шот ${i + 1}: роль должна быть evidence/illustration`);
    if (fact.length < 12 || !a.includes(norm(fact))) throw new Error(`Шот ${i + 1}: факт не найден в статье — сценарий отклонён`);
    const seconds = [4, 6, 6, 5][i] ?? 5;
    let overlay_cues:OverlayCue[]=[];
    try { overlay_cues=validateOverlayCues(s.overlay_cues,seconds); } catch { /* optional unusable legacy cues skip */ }
    const planned=validateOverlayIntents(s.overlay_intents,text);
    if (overlay_cues.some(c => !text.includes(c.speech))) throw new Error(`Шот ${i + 1}: фраза оверлея отсутствует в озвучке`);
    return { text, caption, fact, brief, role: s.role, seconds, overlay_cues,overlay_intents:planned.intents,overlay_warnings:planned.skipped };
  }) };
}
