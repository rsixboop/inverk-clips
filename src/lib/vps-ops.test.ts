import { describe, expect, it } from "vitest";
import { agentState, failedServices, parseOp, parseRedditUrl } from "./vps-ops";

describe("vps ops allowlist", () => {
  it("rejects operations outside the allowlist, including publishing", () => {
    expect(() => parseOp("buffer.publish", {})).toThrow();
    expect(() => parseOp("shell", { cmd: "rm -rf /" })).toThrow();
  });
  it("parses reddit post urls to t3_ ids", () => {
    expect(parseRedditUrl("https://www.reddit.com/r/GTA6/comments/1ab2cd/some_title/")).toEqual({ community: "GTA6", id: "t3_1ab2cd" });
    expect(parseRedditUrl("https://www.reddit.com/r/GTA6/")).toBeNull();
    expect(() => parseOp("reddit.add", { url: "https://evil.example/r/a/comments/abc/" })).toThrow();
  });
  it("collection: enabled flag + minutes 5..1440", () => {
    expect(() => parseOp("collect.set", { enabled: true, minutes: 4 })).toThrow();
    expect(parseOp("collect.set", { enabled: false, minutes: 30 }).args).toEqual({ enabled: false, minutes: 30 });
  });
  it("buffer draft needs a 24-hex channel and https video", () => {
    expect(() => parseOp("buffer.create_draft", { channel_id: "6b00651cece6dfde5f33640c", text: "x", video_url: "http://a/v.mp4" })).toThrow();
    expect(parseOp("buffer.create_draft", { channel_id: "6b00651cece6dfde5f33640c", text: "x", video_url: "https://a/v.mp4" }).op).toBe("buffer.create_draft");
  });
});

describe("agent badge", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  it("never paired / online within 75s / stale after", () => {
    expect(agentState(null, now)).toBe("never");
    expect(agentState({ last_seen_at: "2026-11-20T11:59:00Z" }, now)).toBe("online");
    expect(agentState({ last_seen_at: "2026-11-20T11:58:40Z" }, now)).toBe("stale");
  });
  it("reports failed services separately", () => {
    expect(failedServices({ "a.service": { active: "active", result: "success" }, "b.service": { active: "failed", result: "exit-code" } })).toEqual(["b.service"]);
  });
});
