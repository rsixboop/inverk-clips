export type Observation = "live" | "offline" | "unknown";
export function pollBackoff(failures: number) { return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, Math.max(0, failures - 1))); }
export function captureEligible(m: { enabled: boolean; archived_at: string | null; rights_confirmed: boolean; media_mode: string; observation: string; observed_at: string | null }, paused: boolean, now = Date.now()) {
  return !paused && m.enabled && !m.archived_at && m.rights_confirmed && m.media_mode === "recorder" && m.observation === "live" && Boolean(m.observed_at && now - Date.parse(m.observed_at) < 5 * 60_000);
}
export function recorderHealth(state: { at?: string; ready?: boolean; buffer_s?: number } | null, now = Date.now()) {
  const fresh = Boolean(state?.at && now - Date.parse(state.at) < 90_000);
  return { heartbeat: !state?.at ? "never" : fresh ? "fresh" : "stale", ready: fresh && state?.ready === true, buffer_s: fresh ? state?.buffer_s ?? 0 : null };
}
