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
      instructions: "You are a GTA VI news editor. Use ONLY facts from the article. First list 3 possible angles and score each 1-5 on novelty, usefulness to the viewer and visual provability; pick the best. If no angle scores >=3 on novelty and usefulness, return {\"reject\":true,\"reason\":\"...\"}. Never invent sensations. Otherwise write a 4-shot English TikTok script (hook, fact, fact, question). Per shot: text = narration (<=110 chars); caption = short on-screen label (<=40 chars, separate from narration); fact = EXACT verbatim quote (12-160 chars) from the article; brief = concrete visual (<=160 chars, e.g. 'official screenshot of Vice City skyline'); role is decided by what the frame SHOWS: 'evidence' only if the visual itself proves the fact (quote card/screenshot of the source), 'illustration' for explanatory graphics, diagrams or official game footage. Alternate evidence with explanatory illustration; at most 2 evidence shots, never evidence on every shot. JSON: {\"angles\":[{\"angle\":\"\",\"score\":0}],\"angle\":\"\",\"shots\":[{\"text\":\"\",\"caption\":\"\",\"fact\":\"\",\"brief\":\"\",\"role\":\"illustration\"}]}",
      input: [{ role: "user", content: `ARTICLE:\n${text}\nReturn JSON.` }], text: { format: { type: "json_object" } } } as any);
    let out: string | undefined = r?.output_text;
    if (!out) for (const o of r?.output ?? []) for (const x of o?.content ?? []) if (x?.type === "output_text") out = x.text;
    let j: any; try { j = JSON.parse(out ?? ""); } catch { throw new Error("ИИ вернул некорректный ответ"); }
    return { url: data.url, via, fetched_at: new Date().toISOString(), ...validateScript(j, text) };
}
