import { describe, expect, it } from "vitest";
import { buildEdit } from "./shotstack";

const segs = [{ url: "https://x.test/a.mp4", trim: 2, length: 15 }, { url: "https://x.test/b.mp4", trim: 0, length: 15 }];
describe("shotstack edit", () => {
  it("renders 1080x1920 mp4 at 30fps", () => {
    expect(buildEdit({ segments: segs, audioMode: "voiceover", script: "Hi", language: "en" }).output).toEqual({ format: "mp4", size: { width: 1080, height: 1920 }, fps: 30 });
  });
  it("voiceover: clips play back-to-back and the last stretches to speech end (no black tail)", () => {
    const e = buildEdit({ segments: segs, audioMode: "voiceover", script: "Hi", language: "ru" }) as any;
    const vo = e.timeline.tracks[1].clips[0];
    expect(vo.asset).toMatchObject({ type: "audio", model: "elevenlabs-multilingual-v2", options: { voice: "Daniel", language: "ru" } });
    expect(vo.length).toBe("auto");
    const f = e.timeline.tracks[2].clips;
    expect(f[1].start).toBe(15);
    expect(f[1].length).toBe("end");
    expect(e.timeline.tracks[0].clips[0].asset.src).toBe("alias://voiceover");
  });
  it("original audio keeps fixed lengths, captions the footage", () => {
    const e = buildEdit({ segments: segs, audioMode: "original", script: "", language: "en" }) as any;
    expect(e.timeline.tracks).toHaveLength(2);
    expect(e.timeline.tracks[1].clips[1].length).toBe(15);
    expect(e.timeline.tracks[1].clips[0].asset).toMatchObject({ volume: 1, trim: 2 });
  });
  it("refuses empty footage", () => {
    expect(() => buildEdit({ segments: [], audioMode: "original", script: "", language: "en" })).toThrow();
  });
});
