import { describe, it, expect } from "vitest";
import { PILOT, pilotValid, totalSeconds } from "./news-pilot";
describe("GTA VI news pilot", () => {
  it("has 4 shots totalling 18-23 s", () => { expect(PILOT).toHaveLength(4); expect(totalSeconds(PILOT)).toBe(21); expect(pilotValid(PILOT)).toBe(true); });
  it("rejects a 25 s cut", () => { expect(pilotValid(PILOT.map((s) => ({ ...s, seconds: 6.25 })))).toBe(false); });
});
