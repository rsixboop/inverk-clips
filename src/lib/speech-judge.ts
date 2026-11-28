// Pure normalization of the AI dialogue verdict; clamps the span to the transcript and 8–60 s.
export type SpeechVerdict = { keep: boolean; score: number; start: number; end: number; reason: string; setup: string; payoff: string };
export const SPEECH_MIN_SCORE = 0.65;
export function normalizeSpeechJudge(raw: any, lines: { t: number }[]): SpeechVerdict {
  const lo = lines.length ? lines[0]!.t : 0, hi = lines.length ? lines[lines.length - 1]!.t + 5 : 0;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  let start = Math.min(Math.max(num(raw?.start, lo), lo), hi), end = Math.min(Math.max(num(raw?.end, hi), start), hi);
  if (end - start > 60) end = start + 60;
  const score = Math.min(1, Math.max(0, num(raw?.score, 0)));
  const s = (v: unknown) => String(v ?? "").slice(0, 200);
  const keep = raw?.keep === true && score >= SPEECH_MIN_SCORE && end - start >= 8;
  return { keep, score, start, end, reason: s(raw?.reason) || (keep ? "" : "рутина"), setup: s(raw?.setup), payoff: s(raw?.payoff) };
}
