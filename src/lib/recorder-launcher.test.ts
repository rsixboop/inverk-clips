import { describe, expect, it } from "vitest";
import { buildWindowsLauncher } from "./recorder-launcher";
describe("windows launcher", () => {
  it("embeds only the app URL (no token), uses CRLF and finds Streamlink's Python as fallback", () => {
    const bat = buildWindowsLauncher("https://prompt-to-pocket-clips.lovable.app/sources?x=\"&del");
    expect(bat).toContain('set "INVERK_URL=https://prompt-to-pocket-clips.lovable.app"');
    expect(bat).not.toMatch(/lrw_/);
    expect(bat.split("\r\n").length).toBeGreaterThan(20);
    expect(bat).toContain("Streamlink\\Python\\python.exe");
  });
});
