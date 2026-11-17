// Pure export timing rules for /news (client-safe).
export type TimelineMedia = { video: boolean; catalog: boolean; duration?: number | undefined } | null;
export type TimelineShot = { seconds: number; role?: "evidence" | "illustration" };
/** Fit shot lengths to the voiceover (proportional) and report anything that would stretch, freeze or mislabel material. */
export function planTimeline(shots: TimelineShot[], media: TimelineMedia[], voiceSec: number | null) {
  const errors: string[] = [];
  const base = shots.reduce((a, s) => a + s.seconds, 0);
  const k = voiceSec && voiceSec > 0 ? (voiceSec + 0.3) / base : 1;
  const seconds = shots.map((s) => Math.round(s.seconds * k * 100) / 100);
  const total = seconds.reduce((a, b) => a + b, 0);
  if (total < 15 || total > 30) errors.push(`Общая длительность ${total.toFixed(1)} с вне 15–30 с`);
  shots.forEach((s, i) => {
    const m = media[i];
    if (!m) { errors.push(`Шот ${i + 1}: нет материала`); return; }
    if (s.role === "evidence" && m.catalog) errors.push(`Шот ${i + 1}: evidence — тематическое фото не доказательство, загрузите скрин/запись источника`);
    if (m.video && (!m.duration || m.duration + 0.05 < seconds[i]!)) errors.push(`Шот ${i + 1}: клип ${m.duration?.toFixed(1) ?? "?"} с короче шота ${seconds[i]!.toFixed(1)} с — выберите скриншот или более длинный файл (растягивать/замораживать не будем)`);
  });
  return { seconds, total, errors };
}
