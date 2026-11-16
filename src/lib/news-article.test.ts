import { describe, expect, it } from "vitest";
import { isNewswireUrl, validateScript } from "./news-article";
const art = "GTA VI targets 30 frames per second on consoles. PS5 Pro adds PSSR and ray-traced shadows.";
describe("news article", () => {
  it("only official newswire URLs", () => {
    expect(isNewswireUrl("https://www.rockstargames.com/newswire/article/89834o94713o21/pre-load-grand-theft-auto-vi-now")).toBe(true);
    expect(isNewswireUrl("https://evil.com/newswire/article/x")).toBe(false);
    expect(isNewswireUrl("http://www.rockstargames.com/newswire/article/x")).toBe(false);
  });
  it("rejects facts absent from article", () => {
    const ok = [0, 1, 2, 3].map(() => ({ text: "t", fact: "targets 30 frames per second" }));
    expect(validateScript(ok, art)).toHaveLength(4);
    expect(() => validateScript([...ok.slice(0, 3), { text: "t", fact: "runs at 60 FPS on PS5 Pro" }], art)).toThrow(/не найден/);
  });
});
