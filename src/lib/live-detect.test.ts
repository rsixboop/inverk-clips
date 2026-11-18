import { describe, expect, it } from "vitest";
import { countTwitchEmotes, countYoutubeEmotes, emptyDetector, feed, parseLiveInput } from "./live-detect";

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
