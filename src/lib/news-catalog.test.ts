import { describe, it, expect } from "vitest";
import { CATALOG, findAsset, pickAssets } from "./news-catalog";
import { PILOT } from "./news-pilot";
describe("news catalog", () => {
  it("picks 4 distinct catalog assets for the pilot", () => { const ids = pickAssets(PILOT); expect(new Set(ids).size).toBe(4); ids.forEach((i) => expect(findAsset(i)).toBeTruthy()); });
  it("matches shot text to tags", () => { expect(pickAssets([{ text: "Boats in Leonida Keys", material: "" }])[0]).toBe("lk01"); expect(CATALOG.length).toBeGreaterThanOrEqual(15); });
  it("leaves zero-match shots empty", () => { expect(pickAssets([{ text: "zzz qqq", material: "" }])[0]).toBe(""); });
  it("no substring false positives", () => {
    expect(pickAssets([{ text: "The article says yes", material: "" }])[0]).toBe("");
    expect(pickAssets([{ text: "Here is proof", material: "" }])[0]).toBe("");
  });
  it("evidence stays empty and brief wins", () => {
    expect(pickAssets([{ text: "boat", material: "", role: "evidence" }])[0]).toBe("");
    expect(pickAssets([{ text: "city", material: "", brief: "swamp with alligator" }])[0]).toBe("gr02");
  });
  it("only knows fixed IDs", () => { expect(findAsset("https://evil.com")).toBeUndefined(); expect(CATALOG.length).toBeGreaterThanOrEqual(4); });
});
