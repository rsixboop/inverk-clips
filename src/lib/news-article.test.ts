import { describe, expect, it } from "vitest";
import { isNewswireUrl, validateScript } from "./news-article";
const art = "GTA VI targets 30 frames per second on consoles. PS5 Pro adds PSSR and ray-traced shadows.";
describe("news article", () => {
  it("only official newswire URLs", () => {
    expect(isNewswireUrl("https://www.rockstargames.com/newswire/article/89834o94713o21/pre-load-grand-theft-auto-vi-now")).toBe(true);
    expect(isNewswireUrl("https://evil.com/newswire/article/x")).toBe(false);
    expect(isNewswireUrl("http://www.rockstargames.com/newswire/article/x")).toBe(false);
  });
  const sh = (fact: string) => ({ text: "t", caption: "30 FPS", fact, brief: "official screenshot", role: "illustration" });
  const ok = [0, 1, 2, 3].map(() => sh("targets 30 frames per second"));
  it("returns angle and shot fields", () => {
    const r = validateScript({ angle: "PS5 Pro vs 30fps", shots: ok }, art);
    expect(r.angle).toBe("PS5 Pro vs 30fps"); expect(r.shots[0]).toMatchObject({ caption: "30 FPS", role: "illustration", seconds: 4 });
  });
  it("allows no-spoiler shots with empty on-screen caption", () => {
    const r = validateScript({ angle: "Skip obvious headline", shots: ok.map(x => ({ ...x, caption: "" })) }, art);
    expect(r.shots.every(s => s.caption === "")).toBe(true);
  });
  it("rejects facts absent from article", () => {
    expect(() => validateScript({ angle: "a", shots: [...ok.slice(0, 3), sh("runs at 60 FPS on PS5 Pro")] }, art)).toThrow(/не найден/);
  });
  it("honours model rejection of weak article", () => { expect(() => validateScript({ reject: true, reason: "weak" }, art)).toThrow(/отклонена/); });
  it("requires evidence/illustration role", () => { expect(() => validateScript({ angle: "a", shots: ok.map((x) => ({ ...x, role: "proof" })) }, art)).toThrow(/роль/); });
});
