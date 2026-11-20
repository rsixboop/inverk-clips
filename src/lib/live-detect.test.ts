import { describe, expect, it } from "vitest";
import { countReactions, countTwitchEmotes, countYoutubeEmotes, emptyDetector, feed, parseLiveInput } from "./live-detect";

const T0 = 1_700_000_000_000;
const quiet = (b: number) => [0, 1].map((i) => ({ ts: T0 + b * 10_000 + i * 1000, author: `q${i}`, emotes: 0 }));
const burst = (b: number, n: number) => Array.from({ length: n }, (_, i) => ({ ts: T0 + b * 10_000 + i * 100, author: `u${i}`, emotes: 2 }));

describe("live spike detector", () => {
  it("flags a distinct-chatter spike after warmup with pre/post window", () => {
    const s = emptyDetector(); const ev = [...Array.from({ length: 8 }, (_, b) => quiet(b)).flat(), ...burst(8, 20)];
    const w = feed(s, ev, T0 + 100_000, true);
    expect(w).toHaveLength(1);
    expect(w[0]!.peak).toBe(T0 + 80_000); expect(w[0]!.start).toBe(T0 + 60_000); expect(w[0]!.end).toBe(T0 + 105_000); expect(w[0]!.chatters).toBe(20);
  });
  it("one spammer repeating does not count as a spike", () => {
    const s = emptyDetector(); const spam = Array.from({ length: 50 }, (_, i) => ({ ts: T0 + 80_000 + i * 10, author: "bot", emotes: 5 }));
    expect(feed(s, [...Array.from({ length: 8 }, (_, b) => quiet(b)).flat(), ...spam], T0 + 100_000, true)).toHaveLength(0);
  });
  it("merges overlapping spikes into one window keeping the first start", () => {
    const s = emptyDetector(); const ev = [...Array.from({ length: 8 }, (_, b) => quiet(b)).flat(), ...burst(8, 20), ...burst(10, 30)];
    const w = feed(s, ev, T0 + 120_000, true);
    expect(w).toHaveLength(1); expect(w[0]!.start).toBe(T0 + 60_000); expect(w[0]!.end).toBe(T0 + 125_000); expect(w[0]!.chatters).toBe(30);
  });
  it("adapts to a busy channel baseline", () => {
    const s = emptyDetector(); const busy = (b: number) => burst(b, 20);
    expect(feed(s, Array.from({ length: 10 }, (_, b) => busy(b)).flat(), T0 + 110_000, true)).toHaveLength(0);
  });
  it("does not trigger during warmup", () => { expect(feed(emptyDetector(), burst(0, 40), T0 + 20_000, true)).toHaveLength(0); });
  it("counts emotes", () => { expect(countTwitchEmotes("25:0-4,6-10/1902:12-16")).toBe(3); expect(countYoutubeEmotes("lol :face-blue-smiling: 😂🔥")).toBe(3); });
  it("parses channel and live inputs", () => {
    expect(parseLiveInput("@MrBeast")).toEqual({ platform: "youtube", handle: "MrBeast" });
    expect(parseLiveInput("https://www.youtube.com/live/abc123XYZ_1")).toEqual({ platform: "youtube", videoId: "abc123XYZ_1" });
    expect(parseLiveInput("youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ platform: "youtube", videoId: "dQw4w9WgXcQ" });
    expect(parseLiveInput("https://twitch.tv/Shroud")).toEqual({ platform: "twitch", login: "shroud" });
    expect(parseLiveInput("https://evil.example/x")).toBeNull();
  });
});

describe("mixed RU/EN reactions", () => {
  const react = (b: number, texts: string[]) => texts.map((text, i) => ({ ts: T0 + b * 10_000 + i * 100, author: `r${i}`, emotes: 0, text }));
  const warm = () => Array.from({ length: 8 }, (_, b) => quiet(b)).flat();
  it("normalizes case and repeats", () => {
    expect(countReactions("АХАХАХАХАХ")).toBe(1); expect(countReactions("ОРУУУУ жеееесть")).toBe(2);
    expect(countReactions("hahahaHAHA LMAOOOO")).toBe(2); expect(countReactions("NO WAY KEKW")).toBe(2);
    expect(countReactions("хорошая игра")).toBe(0); expect(countReactions("hello hall")).toBe(0);
  });
  it("RU burst of distinct users is a spike", () => {
    const w = feed(emptyDetector(), [...warm(), ...react(8, ["ахаха", "ору", "жесть", "лол", "АХАХАХ", "ору ору", "жесть!!", "лол)"])], T0 + 100_000, true);
    expect(w).toHaveLength(1); expect(w[0]!.chatters).toBe(8); expect(w[0]!.emotes).toBe(9);
  });
  it("EN burst of distinct users is a spike", () => {
    const w = feed(emptyDetector(), [...warm(), ...react(8, ["hahaha", "lmao", "no way", "LOL", "KEKW", "omegalul", "LMAOOO", "haha no way"])], T0 + 100_000, true);
    expect(w).toHaveLength(1); expect(w[0]!.emotes).toBe(9);
  });
  it("mixed RU/EN burst is a spike", () => {
    const w = feed(emptyDetector(), [...warm(), ...react(8, ["ахаха lmao", "ору", "no way", "жесть KEKW", "lol", "кек", "hahaha", "ОРУ"])], T0 + 100_000, true);
    expect(w).toHaveLength(1);
  });
  it("one spammer with reactions is capped and never spikes", () => {
    const s = emptyDetector();
    const spam = Array.from({ length: 50 }, (_, i) => ({ ts: T0 + 80_000 + i * 100, author: "spam", emotes: 5, text: "АХАХАХ ору жесть lmao KEKW" }));
    expect(feed(s, [...warm(), ...spam], T0 + 100_000, true)).toHaveLength(0);
    expect(s.mean).toBeLessThan(10);
  });
});
