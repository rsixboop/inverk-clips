// Gameplay-event highlights: pure rules for vision-detected story beats / novel interactions, independent of chat.
// Server: src/server/live-worker.server.ts action "event_scan"; recorder: event_loop in public/recorder/recorder.py.
export type EventKind = "story_beat" | "novel_interaction" | "routine" | "none" | "unavailable";
export type GameEvent = { kind: EventKind; label: string; confidence: number; setup?: string | undefined; payoff?: string | undefined };
export type EventState = { scan_at?: string; events?: { label: string; at: string }[] };

export const EVENT_MIN_CONFIDENCE = 0.75;
export const EVENT_SCAN_INTERVAL_MS = 40_000;      // per channel
export const EVENT_SCANS_PER_MIN_PER_USER = 3;     // across all channels: bounds vision cost (3 low-detail frames each)
export const EVENT_DEDUP_MS = 10 * 60_000;

const KINDS: EventKind[] = ["story_beat", "novel_interaction", "routine", "none"];
export function normalizeEvent(raw: any): GameEvent {
  const kind = KINDS.includes(raw?.kind) ? raw.kind : "none";
  const c = Math.max(0, Math.min(1, Number(raw?.confidence) || 0));
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
  return { kind, label: s(raw?.label, 80), confidence: c, setup: s(raw?.setup, 120) || undefined, payoff: s(raw?.payoff, 120) || undefined };
}

const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
export function similar(a: string, b: string) {
  const A = words(a), B = words(b); if (!A.size || !B.size) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.5;
}

/** Budget: per-channel interval, plus a per-user cap across channels (scan_at of the user's other monitors). */
export function canScan(state: EventState, otherScanAts: (string | undefined)[], now: number) {
  if (state.scan_at && now - Date.parse(state.scan_at) < EVENT_SCAN_INTERVAL_MS) return { ok: false, why: "interval" };
  const recent = otherScanAts.filter((t) => t && now - Date.parse(t) < 60_000).length;
  if (recent >= EVENT_SCANS_PER_MIN_PER_USER) return { ok: false, why: "budget" };
  return { ok: true, why: "" };
}

/** Keep only a confident, non-routine, non-repeated event. Reason is human-readable Russian for Sources. */
export function decideEvent(ev: GameEvent, state: EventState, now: number): { keep: boolean; reason: string } {
  if (ev.kind === "routine" || ev.kind === "none" || ev.kind === "unavailable") return { keep: false, reason: `рутина/нет события${ev.label ? `: ${ev.label}` : ""}` };
  if (ev.confidence < EVENT_MIN_CONFIDENCE || !ev.label) return { keep: false, reason: `неуверенно (${ev.confidence.toFixed(2)})` };
  const dup = (state.events ?? []).find((e) => now - Date.parse(e.at) < EVENT_DEDUP_MS && similar(e.label, ev.label));
  if (dup) return { keep: false, reason: `повтор: «${dup.label}»` };
  const kind = ev.kind === "story_beat" ? "сюжетный момент" : "новое взаимодействие";
  return { keep: true, reason: `Игровое событие (${kind}, ${ev.confidence.toFixed(2)}): ${ev.label}${ev.setup ? ` · завязка: ${ev.setup}` : ""}${ev.payoff ? ` · развязка: ${ev.payoff}` : ""}` };
}

export function rememberEvent(state: EventState, label: string, nowIso: string): EventState {
  return { ...state, events: [...(state.events ?? []), { label, at: nowIso }].slice(-10) };
}
/** Chat only boosts ranking; it never gates this path. */
export const eventScore = (confidence: number, chatters: number) => Math.round((confidence + Math.min(1, chatters / 50)) * 100) / 100;
/** Server-only wrapper (dynamic import keeps the vision client out of this pure module's graph). */
export async function classifyEventSafe(frames: string[]) { return (await import("@/server/live-vision.server")).classifyEvent(frames); }
