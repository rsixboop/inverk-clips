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

import { trackGame, type GameTrack } from "./live-scene";
it("keeps five independent streams stable through alternating guesses", () => {
  for (const game of ["GTA VI", "Rust", "GTA V", "Alan Wake", "Minecraft"]) {
    let track: GameTrack | undefined;
    const readings = [game, game, game, "Watch Dogs", game, "Watch Dogs", game, "Portal", "Portal", "Portal"];
    const names = readings.map((name, i) => {
      track = trackGame(track, { game: name, activity: "gameplay", confidence: 0.95 }, i * 60000);
      return track.game;
    });
    expect(names).toEqual([null, null, game, game, game, game, game, game, game, "Portal"]);
  }
});
