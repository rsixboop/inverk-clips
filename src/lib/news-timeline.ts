// Deterministic, client-safe pacing for GTA VI news. Beat cuts are visual decisions;
// source video plays continuously inside each narration shot (never slowed or looped).
export type TimelineMedia = { video: boolean; catalog: boolean; duration?: number | undefined } | null;
export type TimelineShot = { seconds: number; role?: "evidence" | "illustration"; text?: string };
export type TimelineBeat = { shot: number; cut: number; start: number; seconds: number; end: number };

const round = (n: number) => Math.round(n * 100) / 100;

/** Fit a 4-shot narration to the real voice duration, then divide its visuals into
 * deliberate 1.4–2.3s beats. The voice/sentences stay intact across visual cuts.
 * Beats are useful both for framing changes and for rendering continuous b-roll
 * behind short proof labels rather than long fullscreen quote cards. */
export function planTimeline(shots: TimelineShot[], media: TimelineMedia[], voiceSec: number | null) {
  const errors: string[] = [];
  const base = shots.reduce((sum, s) => sum + s.seconds, 0);
  if (!shots.length || shots.some((s) => !Number.isFinite(s.seconds) || s.seconds <= 0) || base <= 0) {
    return { seconds: [], total: 0, beats: [] as TimelineBeat[], errors: ["У шотов должна быть положительная длительность"] };
  }
  const target = voiceSec != null && Number.isFinite(voiceSec) && voiceSec > 0 ? voiceSec + 0.3 : base;
  // Rounded cumulative boundaries avoid accumulated centisecond drift at 30 FPS.
  let elapsed = 0;
  const seconds = shots.map((s, i) => {
    const next = i === shots.length - 1 ? round(target) : round(elapsed + target * s.seconds / base);
    const duration = round(next - round(elapsed));
    elapsed = next;
    return duration;
  });
  const beats: TimelineBeat[] = [];
  let at = 0;
  seconds.forEach((length, shot) => {
    const count = Math.max(1, Math.ceil(length / 2.25));
    // A little natural variation, with a hard cap, rather than fixed metronomic 1s cuts.
    const weights = Array.from({ length: count }, (_, i) => [1.04, 0.96, 1][i % 3]!);
    const weightSum = weights.reduce((a, b) => a + b, 0);
    let used = 0;
    for (let cut = 0; cut < count; cut++) {
      const endInShot = cut === count - 1 ? length : round(length * weights.slice(0, cut + 1).reduce((a, b) => a + b, 0) / weightSum);
      const duration = round(endInShot - used);
      const start = round(at + used);
      beats.push({ shot, cut, start, seconds: duration, end: round(start + duration) });
      used = endInShot;
    }
    at = round(at + length);
  });
  const total = round(at);
  if (total < 15 || total > 30) errors.push(`Общая длительность ${total.toFixed(1)} с вне 15–30 с`);
  shots.forEach((s, i) => {
    const m = media[i];
    if (!m) { errors.push(`Шот ${i + 1}: нет материала`); return; }
    if (s.role === "evidence" && m.catalog) errors.push(`Шот ${i + 1}: evidence — тематическое фото не доказательство, загрузите скрин/запись источника`);
    if (m.video && (!m.duration || m.duration + 0.05 < seconds[i]!)) errors.push(`Шот ${i + 1}: клип ${m.duration?.toFixed(1) ?? "?"} с короче шота ${seconds[i]!.toFixed(1)} с — выберите скриншот или более длинный файл (растягивать/замораживать не будем)`);
  });
  return { seconds, total, beats, errors };
}
