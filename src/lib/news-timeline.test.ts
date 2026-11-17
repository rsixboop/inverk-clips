import { describe, expect, it } from "vitest";
import { planTimeline } from "./news-timeline";
const shots = [{ seconds: 4 }, { seconds: 6 }, { seconds: 6 }, { seconds: 5 }];
const img = { video: false, catalog: true };
describe("news timeline", () => {
  it("fits total to voiceover", () => { const t = planTimeline(shots, [img, img, img, img], 22.6); expect(t.total).toBeCloseTo(22.9, 1); expect(t.errors).toEqual([]); });
  it("blocks a clip shorter than its shot", () => { expect(planTimeline(shots, [{ video: true, catalog: true, duration: 1.2 }, img, img, img], null).errors[0]).toMatch(/короче/); });
  it("blocks catalog photo on evidence shot", () => { expect(planTimeline([{ seconds: 4, role: "evidence" as const }, ...shots.slice(1)], [img, img, img, img], null).errors[0]).toMatch(/evidence/); });
  it("allows own file on evidence shot", () => { expect(planTimeline([{ seconds: 4, role: "evidence" as const }, ...shots.slice(1)], [{ video: false, catalog: false }, img, img, img], null).errors).toEqual([]); });
});
