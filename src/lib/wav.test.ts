import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeAudio, isMp3, wavDuration } from "./wav";
describe("non-WAV audio (fal MMAudio MP3 with ID3 header)", () => {
  const mp3 = new Uint8Array(readFileSync("src/test/fixtures/sfx-id3.mp3"));
  it("detects ID3 and decodes to PCM instead of throwing 'not WAV'", () => {
    expect(isMp3(mp3)).toBe(true);
    const p = decodeAudio(mp3);
    expect(p.rate).toBe(44100);
    expect(p.channels[0]!.length).toBeGreaterThan(44100);
    expect(wavDuration(mp3)).toBeGreaterThan(1);
  });
});
