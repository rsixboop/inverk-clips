import { describe, expect, it } from "vitest";
import { detectSwitch, normalizeScene } from "./live-scene";
describe("live scene rules", () => {
  it("drops low-confidence game guesses to unknown", () => { expect(normalizeScene({ game: "Rust", activity: "gameplay", confidence: 0.4 })).toMatchObject({ game: null, activity: "unknown" }); });
  it("keeps confident classifications", () => { expect(normalizeScene({ game: "Rust", activity: "gameplay", confidence: 0.9 })).toMatchObject({ game: "Rust", activity: "gameplay" }); });
  it("detects Rust → GTA switch but not GTA VI vs Grand Theft Auto VI", () => {
    expect(detectSwitch("Rust", normalizeScene({ game: "Grand Theft Auto VI", activity: "gameplay", confidence: 0.8 }))).toBe("Rust");
    expect(detectSwitch("GTA VI", normalizeScene({ game: "Grand Theft Auto VI", activity: "menu", confidence: 0.8 }))).toBeNull();
    expect(detectSwitch("Rust", normalizeScene({ game: null, activity: "chatting", confidence: 0.9 }))).toBeNull();
  });
});
