import { describe, expect, it } from "vitest";
import { normalizeSpeechJudge } from "@/lib/speech-judge";
const lines = [{ t: 0 }, { t: 20 }, { t: 100 }];
describe("speech judge", () => {
  it("keeps a confident span clamped to 60 s", () => { const v = normalizeSpeechJudge({ keep: true, score: 0.9, start: 10, end: 200, reason: "x" }, lines); expect(v.keep).toBe(true); expect(v.end - v.start).toBe(60); });
  it("rejects low confidence", () => expect(normalizeSpeechJudge({ keep: true, score: 0.5, start: 0, end: 20 }, lines).keep).toBe(false));
  it("rejects spans shorter than 8 s", () => expect(normalizeSpeechJudge({ keep: true, score: 0.9, start: 5, end: 9 }, lines).keep).toBe(false));
});
