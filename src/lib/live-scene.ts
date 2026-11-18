// Pure rules for per-channel visual game checks (vision output → stored scene + switch detection).
export type Activity = "gameplay" | "menu" | "chatting" | "unknown" | "unavailable";
export type Scene = { game: string | null; activity: Activity; confidence: number; note?: string | undefined };
const ACTS: Activity[] = ["gameplay", "menu", "chatting", "unknown"];
export const MIN_CONFIDENCE = 0.6, SCENE_INTERVAL_MS = 60_000;

export function normalizeScene(raw: unknown): Scene {
  const r = (raw ?? {}) as Record<string, unknown>;
  const confidence = Math.max(0, Math.min(1, Number(r["confidence"]) || 0));
  const activity = ACTS.includes(r["activity"] as Activity) ? (r["activity"] as Activity) : "unknown";
  let game = typeof r["game"] === "string" ? r["game"].trim().slice(0, 60) : null;
  if (!game || /^(unknown|none|n\/a|null)$/i.test(game) || confidence < MIN_CONFIDENCE) game = null;
  return { game, activity: confidence < MIN_CONFIDENCE && activity !== "chatting" ? "unknown" : activity, confidence, note: typeof r["note"] === "string" ? r["note"].slice(0, 160) : undefined };
}
const key = (g: string) => g.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/^grandtheftauto/, "gta").replace(/^gta(vi|6)$/, "gta6");
/** A switch is a confident game that differs from the last confidently identified game. */
export function detectSwitch(prevGame: string | null | undefined, s: Scene): string | null {
  return prevGame && s.game && key(prevGame) !== key(s.game) ? prevGame : null;
}
