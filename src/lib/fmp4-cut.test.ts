import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fmp4Buffer, clipWindow } from "./fmp4-cut";
import { inspectMp4 } from "./mp4-inspect";

const dir = mkdtempSync(join(tmpdir(), "fmp4-"));
const src = join(dir, "src.mp4");
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30", "-f", "lavfi", "-i", "sine=f=440:r=48000", "-t", "30",
  "-c:v", "libx264", "-g", "60", "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "1000000", src]);
const whole = new Uint8Array(readFileSync(src));
function fed() { const b = new Fmp4Buffer(); for (let p = 0; p < whole.length; p += 7777) b.push(whole.subarray(p, p + 7777)); return b; }
const probe = (f: string, entry: string) => execFileSync("ffprobe", ["-v", "error", "-show_entries", entry, "-of", "csv=p=0", f]).toString().trim();

describe("fmp4 rolling buffer", () => {
  it("parses arbitrarily split chunks into keyframe fragments", () => {
    const b = fed();
    expect(b.init).not.toBeNull();
    expect(b.bufferedTo).toBeGreaterThan(29);
    expect(b.frags.filter((f) => f.key).length).toBeGreaterThan(10);
  });
  it("cuts a standalone decodable MP4 with audio starting at a keyframe at/before the window", () => {
    const c = fed().cut(10.5, 18)!;
    expect(c.start).toBeLessThanOrEqual(10.5); expect(c.start).toBeGreaterThan(8);
    const out = join(dir, "cut.mp4"); writeFileSync(out, c.bytes);
    const info = inspectMp4(c.bytes); expect(info.video?.codec).toBe("avc1"); expect(info.audio?.codec).toBe("mp4a");
    const dur = Number(probe(out, "format=duration")); expect(dur).toBeGreaterThan(7); expect(dur).toBeLessThan(11);
    execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", out, "-f", "null", "-"]); // full decode
    expect(Number(probe(out, "stream=start_time").split("\n")[0])).toBeLessThan(0.5);
  });
  it("refuses windows not yet buffered and keeps a keyframe head after pruning", () => {
    const b = fed(); expect(b.cut(25, 40)).toBeNull();
    b.prune(10); expect(b.frags[0]!.key).toBe(true); expect(b.bufferedFrom).toBeLessThanOrEqual(b.bufferedTo - 10);
    expect(b.cut(1, 25)!.preRollShort).toBe(true);
  });
  it("uses 20 s before and 15 s after the spike, plus viewer delay", () => {
    expect(clipWindow(100_000, 110_000)).toEqual({ from: 80_000, to: 125_000 });
    expect(clipWindow(100_000, 110_000, 4)).toEqual({ from: 84_000, to: 129_000 });
  });
});
