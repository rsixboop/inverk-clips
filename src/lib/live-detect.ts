// Pure chat-spike detector shared by both live adapters. Chat is folded into 10s buckets; each bucket
// scores distinct chatters + emote weight against an adaptive per-channel baseline (EWMA mean/variance,
// spike buckets excluded). Spikes become pre/post windows that merge when they overlap.
export const BUCKET_MS = 10_000, PRE_MS = 20_000, POST_MS = 15_000, MERGE_GAP_MS = 5_000, WARMUP = 6;
export type ChatEvent = { ts: number; author: string; emotes: number; text?: string };
/** Per-user reaction units per bucket are capped so one spammer cannot fake a spike. */
export const USER_UNIT_CAP = 3;
export type Window = { start: number; end: number; peak: number; score: number; chatters: number; emotes: number };
export type DetectorState = { bucket?: number | undefined; authors: string[]; emotes: number; units?: Record<string, number>; mean: number; var: number; n: number; last?: Window };
export const emptyDetector = (): DetectorState => ({ authors: [], emotes: 0, mean: 0, var: 0, n: 0 });

export function bucketScore(chatters: number, emotes: number) { return chatters + 0.5 * Math.min(emotes, chatters * 4); }
export function threshold(s: DetectorState) { return Math.max(8, s.mean + 3 * Math.sqrt(s.var) + 2); }

/** Close one bucket; returns the (new or merged) window to persist, or null. */
function close(s: DetectorState, bucket: number, chatters: number, emotes: number): Window | null {
  const score = bucketScore(chatters, emotes);
  const spike = s.n >= WARMUP && chatters >= 4 && score >= threshold(s);
  if (!spike) { // adapt baseline only on ordinary buckets
    const a = s.n < WARMUP ? 1 / (s.n + 1) : 0.15, d = score - s.mean;
    s.mean += a * d; s.var = (1 - a) * (s.var + a * d * d); s.n++;
    return null;
  }
  const w: Window = { start: bucket - PRE_MS, end: bucket + BUCKET_MS + POST_MS, peak: bucket, score, chatters, emotes };
  if (s.last && w.start <= s.last.end + MERGE_GAP_MS) {
    const l = s.last; l.end = Math.max(l.end, w.end);
    if (score > l.score) Object.assign(l, { peak: bucket, score, chatters, emotes });
    return { ...l };
  }
  s.last = w; return { ...w };
}

/** Feed time-ordered events; `now` closes buckets that ended. `continuous` = every bucket was observed
 * (YouTube polling), so silent buckets count as zero; sampled sources (anonymous Twitch) skip gaps. */
export function feed(s: DetectorState, events: ChatEvent[], now: number, continuous: boolean): Window[] {
  const out = new Map<number, Window>();
  const emit = (w: Window | null) => { if (w) out.set(w.start, w); };
  const flushTo = (b: number) => {
    while (s.bucket !== undefined && s.bucket < b) {
      emit(close(s, s.bucket, new Set(s.authors).size, s.emotes));
      s.authors = []; s.emotes = 0; s.units = {};
      s.bucket = continuous && s.bucket + BUCKET_MS < b ? s.bucket + BUCKET_MS : undefined;
    }
  };
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    const b = Math.floor(e.ts / BUCKET_MS) * BUCKET_MS;
    if (s.bucket !== undefined && b < s.bucket) continue; // late event for a closed bucket
    flushTo(b); if (s.bucket === undefined) s.bucket = b;
    s.authors.push(e.author);
    const units = (s.units ??= {}), had = units[e.author] ?? 0;
    const add = Math.min(USER_UNIT_CAP - had, e.emotes + (e.text ? countReactions(e.text) : 0));
    if (add > 0) { units[e.author] = had + add; s.emotes += add; }
  }
  flushTo(Math.floor(now / BUCKET_MS) * BUCKET_MS);
  return [...out.values()];
}

/** Twitch IRC `emotes` tag: "25:0-4,6-10/1902:12-16" → 3 */
export function countTwitchEmotes(tag: string | undefined) { return tag ? tag.split("/").reduce((n, p) => n + (p.split(":")[1]?.split(",").length ?? 0), 0) : 0; }
/** YouTube: :custom-emoji: tokens plus unicode pictographs. */
export function countYoutubeEmotes(text: string) { return (text.match(/:[a-z0-9_-]+:/gi)?.length ?? 0) + (text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0); }

export type ParsedLive = { platform: "youtube"; videoId?: string; channelId?: string; handle?: string } | { platform: "twitch"; login: string };
export function parseLiveInput(raw: string): ParsedLive | null {
  const s = raw.trim();
  if (/^@[\w.-]{3,30}$/.test(s)) return { platform: "youtube", handle: s.slice(1) };
  if (/^UC[\w-]{22}$/.test(s)) return { platform: "youtube", channelId: s };
  let u: URL; try { u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`); } catch { return null; }
  const h = u.hostname.replace(/^(www|m)\./, ""), parts = u.pathname.split("/").filter(Boolean);
  if (h === "twitch.tv") return parts[0] && /^\w{3,25}$/.test(parts[0]) ? { platform: "twitch", login: parts[0].toLowerCase() } : null;
  if (h === "youtu.be") return parts[0] ? { platform: "youtube", videoId: parts[0] } : null;
  if (h !== "youtube.com") return null;
  if (u.searchParams.get("v")) return { platform: "youtube", videoId: u.searchParams.get("v")! };
  if ((parts[0] === "live" || parts[0] === "shorts") && parts[1]) return { platform: "youtube", videoId: parts[1] };
  if (parts[0]?.startsWith("@")) return { platform: "youtube", handle: parts[0].slice(1) };
  if (parts[0] === "channel" && parts[1]) return { platform: "youtube", channelId: parts[1] };
  return null;
}

// Mixed RU/EN laughter/shock words and text emotes (BTTV/7TV/Twitch names users type). Text is normalized:
// lowercase, ё→е, letter runs of 3+ collapsed to 2, so "АХАХАХАХ", "ахахаха", "hahahaHA" all match.
const REACTION_RE = new RegExp([
  "(?:а?х(?:а|е|и)){2,}х?", "(?:х(?:а|е)){2,}", "ору+", "оруу", "жесть", "жеесть", "лол", "кек", "капец", "пипец", "офигеть", "ничего себе", "нифига",
  "a?(?:h(?:a|e|i)){2,}h?", "lo+l", "lmf?a+o+", "rofl", "omg", "no way", "wtf", "kekw?", "lul", "omegalul", "pog(?:gers|champ|u)?", "monkas", "pepelaugh", "sadge", "icant", "xd+",
].map((x) => `(?<![\\p{L}\\p{N}])${x}(?![\\p{L}\\p{N}])`).join("|"), "gu");
export function normalizeChat(text: string) {
  return text.toLowerCase().replace(/ё/g, "е").replace(/(\p{L})\1{2,}/gu, "$1$1").replace(/\s+/g, " ").trim();
}
/** Number of reaction tokens in one message (caller caps per user per bucket). */
export function countReactions(text: string) { return normalizeChat(text).match(REACTION_RE)?.length ?? 0; }
