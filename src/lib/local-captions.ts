// Pure rules for folder-import candidates: when the recorder may render the next candidate (one at a time,
// only after the previous one was reviewed) and how whisper words become short caption cues.
export type Word = { word: string; start: number; end: number };
export type Cue = { start: number; end: number; text: string; alt?: string };
type Cand = { status: string; review: string | null; created_at: string };

const ACTIVE = ["transcribing", "rendering"];
/** First candidate renders automatically; every next one waits for the user's "next"/"reject" on the latest. */
export function mayRenderNext(cands: Cand[], now = Date.now()): { ok: boolean; why: string } {
  if (!cands.length) return { ok: true, why: "первый кандидат" };
  const latest = [...cands].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
  if (ACTIVE.includes(latest.status) && now - Date.parse(latest.created_at) < 30 * 60_000) return { ok: false, why: "кандидат ещё готовится" };
  if (latest.review === "next" || latest.review === "reject" || latest.status === "failed") return { ok: true, why: "запрошен следующий" };
  return { ok: false, why: "ждёт вашей оценки последнего кандидата" };
}

/** Group words into cues of ≤ maxChars and ≤ maxS seconds, breaking on pauses ≥ 0.6 s. */
export function wordsToCues(words: Word[], maxChars = 34, maxS = 2.8): Cue[] {
  const out: Cue[] = []; let cur: Word[] = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0]!.start, end: cur.at(-1)!.end, text: cur.map((w) => w.word.trim()).join(" ").replace(/\s+([,.!?…])/g, "$1").trim() }); cur = []; };
  for (const w of words) {
    if (!w.word.trim() || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const text = [...cur, w].map((x) => x.word.trim()).join(" ");
    if (cur.length && (text.length > maxChars || w.end - cur[0]!.start > maxS || w.start - cur.at(-1)!.end >= 0.6)) flush();
    cur.push(w);
  }
  flush();
  return out.filter((c) => c.text);
}

/** Cyrillic share decides RU vs EN for the caption's main language; the other one is the translation line. */
export function detectRuEn(text: string): "ru" | "en" {
  const cyr = (text.match(/[а-яё]/gi) ?? []).length, lat = (text.match(/[a-z]/gi) ?? []).length;
  return cyr > lat ? "ru" : "en";
}
