import { describe, expect, it } from "vitest";
import { detectRuEn, mayRenderNext, wordsToCues } from "./local-captions";
const c = (status: string, review: string | null, m: number) => ({ status, review, created_at: new Date(Date.UTC(2026, 10, 18, 12, m)).toISOString() });
describe("folder candidates", () => {
  it("renders exactly one candidate first, then waits for review", () => {
    expect(mayRenderNext([]).ok).toBe(true);
    expect(mayRenderNext([c("done", null, 1)]).ok).toBe(false);
    expect(mayRenderNext([c("done", "ok", 1)]).ok).toBe(false);
    expect(mayRenderNext([c("done", null, 1), c("done", "next", 2)]).ok).toBe(true);
    expect(mayRenderNext([c("transcribing", null, 2)], Date.UTC(2026, 10, 18, 12, 5)).ok).toBe(false);
    expect(mayRenderNext([c("failed", null, 2)]).ok).toBe(true);
  });
  it("splits words on length, duration and pauses", () => {
    const w = (word: string, start: number, end: number) => ({ word, start, end });
    const cues = wordsToCues([w("Он", 0, 0.2), w("прыгнул", 0.2, 0.6), w("!", 0.6, 0.6), w("No", 2, 2.2), w("way", 2.2, 2.5)]);
    expect(cues).toEqual([{ start: 0, end: 0.6, text: "Он прыгнул!" }, { start: 2, end: 2.5, text: "No way" }]);
  });
  it("detects RU vs EN", () => { expect(detectRuEn("ору, жесть")).toBe("ru"); expect(detectRuEn("no way lol")).toBe("en"); });
});
