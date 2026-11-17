import { describe, expect, it } from "vitest";
import { planTimeline } from "./news-timeline";
const shots = [{ seconds: 4 }, { seconds: 6 }, { seconds: 6 }, { seconds: 5 }];
const img = { video: false, catalog: true };
describe("news timeline", () => {
  it("fits total to voiceover", () => { const t = planTimeline(shots, [img, img, img, img], 22.6); expect(t.total).toBeCloseTo(22.9, 1); expect(t.errors).toEqual([]); });
  it("blocks a clip shorter than its shot", () => { expect(planTimeline(shots, [{ video: true, catalog: true, duration: 1.2 }, img, img, img], null).errors[0]).toMatch(/короче/); });
  it("blocks catalog photo on evidence shot", () => { expect(planTimeline([{ seconds: 4, role: "evidence" as const }, ...shots.slice(1)], [img, img, img, img], null).errors[0]).toMatch(/evidence/); });
  it("allows own file on evidence shot", () => { expect(planTimeline([{ seconds: 4, role: "evidence" as const }, ...shots.slice(1)], [{ video: false, catalog: false }, img, img, img], null).errors).toEqual([]); });
  it("splits long narration shots into short visual beats without shifting the voice total", () => {
    const p = planTimeline(shots, [img, img, img, img], 22.6);
    expect(p.beats.length).toBeGreaterThan(shots.length);
    expect(p.beats[0]?.start).toBe(0);
    expect(p.beats.at(-1)?.end).toBe(p.total);
    expect(p.beats.every((b) => b.seconds > 0 && b.seconds < 2.5)).toBe(true);
    p.seconds.forEach((sec, i) => {
      const portion = p.beats.filter((b) => b.shot === i);
      expect(Math.round(portion.reduce((n, b) => n + b.seconds, 0) * 100) / 100).toBe(sec);
    });
  });
  it("keeps exact cumulative lengths across repeated exports", () => {
    const a = planTimeline(shots, [img, img, img, img], 18.35);
    const b = planTimeline(shots, [img, img, img, img], 18.35);
    expect(a).toEqual(b);
    expect(a.total).toBe(18.65);
  });
});
