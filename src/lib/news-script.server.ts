import { htmlToText, isNewswireUrl, validateScript } from "@/lib/news-article";
// Reads an official Newswire article (HTML, or Tavily Extract for JS-rendered pages) and writes a validated 4-shot script.
export async function buildScriptFromArticle(url: string) {
  const data = { url };
  if (!isNewswireUrl(url)) throw new Error("Только официальный Rockstar Newswire");
    const res = await fetch(data.url, { redirect: "manual", signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 InverkClips" } });
    if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`Статья не прочитана (HTTP ${res.status}) — сценарий не создан`);
    const reader = res.body!.getReader(); const chunks: Uint8Array[] = []; let n = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > 3_000_000) { await reader.cancel(); throw new Error("Статья слишком большая"); } chunks.push(value); }
    const html = new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer());
    let text = htmlToText(html).slice(0, 20000), via: "html" | "tavily_extract" = "html";
    if (text.length < 400) { // JS-rendered page: HTML has only the title
      const { tavilyExtract } = await import("@/lib/providers/tavily");
      text = (await tavilyExtract(data.url)).slice(0, 20000); via = "tavily_extract";
    }
    if (!/grand theft auto vi|gta vi/i.test(text) || text.length < 400) throw new Error("В статье не найден текст о GTA VI — сценарий не создан");
    const { generateResponse } = await import("@lovable.dev/ai-gateway");
    const r: any = await generateResponse({ model: "openai/gpt-6-astra",
      instructions: "You are a GTA VI short-video news editor, not a slideshow writer. Use ONLY verified facts from the supplied article. Rate 3 possible angles for novelty, usefulness and visual provability (1–5); reject if no angle is at least 3 for novelty and usefulness. Return 4 concise English narration beats (hook, fact, implication, viewer question), each text <=110 chars, with fact as an EXACT 12–160 character verbatim quote from the article. For EACH beat, make brief a concrete meaningful visual action that clarifies exactly what its words mean: e.g. storage information -> disk-capacity/download diagram; delay -> locked icon; release date -> calendar; deleting a game -> game library with one item removed. B-roll can accompany but must NEVER replace the explanation or masquerade as evidence. Do not use random character portraits, vague city screenshots, full-screen quote cards, invented console UI, unlicensed clips, or factual information not present in source. On-screen caption is OPTIONAL and usually empty. Include it only for a high-impact figure or short phrase that is revealed DURING the corresponding spoken claim; NEVER use generic topic spoilers, duplicate subtitles or preview labels like LOCAL TIME, CONNECTION, PRELOAD, RELEASE DATE. Evidence role ONLY when the visual itself displays verifiable official source content; otherwise illustration. At most 2 evidence shots. Provide captions <=40 characters and visual briefs <=160 characters. Return JSON {\"angles\":[{\"angle\":\"...\",\"score\":3}],\"angle\":\"...\",\"shots\":[{\"text\":\"...\",\"caption\":\"\",\"fact\":\"verbatim from article\",\"brief\":\"exact visual action\",\"role\":\"illustration\"}]}.",
      input: [{ role: "user", content: `ARTICLE:\n${text}\nReturn JSON.` }], text: { format: { type: "json_object" } } } as any);
    let out: string | undefined = r?.output_text;
    if (!out) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") out = x.text;
    let j: any; try { j = JSON.parse(out ?? ""); } catch { throw new Error("ИИ вернул некорректный ответ"); }
    return { url: data.url, via, fetched_at: new Date().toISOString(), ...validateScript(j, text) };
}
