import { describe, expect, it } from "vitest";
import { buildEdit } from "./shotstack";

describe("shotstack edit", () => {
  const base = { videoUrl: "https://x.test/a.mp4", clipStart: 5, clipLength: 40, script: "Hello", language: "en" as const };
  it("renders 1080x1920 mp4 at 30fps", () => {
    const e = buildEdit({ ...base, audioMode: "voiceover" });
    expect(e.output).toEqual({ format: "mp4", size: { width: 1080, height: 1920 }, fps: 30 });
  });
  it("voiceover mode adds speech track and captions follow speech", () => {
    const e = buildEdit({ ...base, audioMode: "voiceover" }) as any;
    expect(e.timeline.tracks).toHaveLength(3);
    expect(e.timeline.tracks[0].clips[0].asset.src).toBe("alias://voiceover");
  });
  it("original audio mode captions the footage and keeps full volume", () => {
    const e = buildEdit({ ...base, audioMode: "original" }) as any;
    expect(e.timeline.tracks).toHaveLength(2);
    expect(e.timeline.tracks[0].clips[0].asset.src).toBe("alias://footage");
    expect(e.timeline.tracks[1].clips[0].asset.volume).toBe(1);
    expect(e.timeline.tracks[1].clips[0].asset.trim).toBe(5);
  });
});
