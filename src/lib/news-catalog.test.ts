import { describe, it, expect } from "vitest";
import { CATALOG, findAsset, pickAssets } from "./news-catalog";
import { PILOT } from "./news-pilot";
describe("news catalog", () => {
  it("picks 4 distinct catalog assets for the pilot", () => { const ids = pickAssets(PILOT); expect(new Set(ids).size).toBe(4); ids.forEach((i) => expect(findAsset(i)).toBeTruthy()); });
  it("matches shot text to tags", () => { expect(pickAssets([{ text: "Boats in Leonida Keys", material: "" }])[0]).toBe("lk01"); expect(CATALOG.length).toBeGreaterThanOrEqual(15); });
  it("never substitutes a random GTA art image for a storage menu", () => {
    expect(pickAssets([{ text: "Rockstar confirmed GTA VI storage requirement", material: "", brief: "console storage interface" }])[0]).toBe("");
    expect(pickAssets([{ text: "Game launch", material: "", brief: "game library with delete button" }])[0]).toBe("");
  });
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

import { existsSync } from "node:fs";
import { CLIPS, LOCAL_MEDIA, mediaUrl } from "./news-catalog";
describe("local media copies", () => {
  it("every fixed ID has a local file", () => {
    for (const id of [...CATALOG.map((a) => a.id), ...CLIPS.map((c) => c.id)]) { expect(LOCAL_MEDIA[id]).toBeTruthy(); expect(existsSync("public" + LOCAL_MEDIA[id])).toBe(true); }
  });
  it("unknown IDs never become local", () => { expect(mediaUrl("x")).toBe("/api/rockstar-media/x"); });
});
