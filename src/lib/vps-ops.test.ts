import { describe, expect, it } from "vitest";
import { agentState, failedServices, parseOp, parseRedditUrl, tiktokPostSchema, tiktokIdemKey } from "./vps-ops";

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

describe("authorized ready TikTok clip", () => {
  const input = { agent_id: "11111111-1111-4111-8111-111111111111", job_id: "22222222-2222-4222-8222-222222222222", channel_id: "6b00651cece6dfde5f33640c", authorized_channel_id: "6b00651cece6dfde5f33640c", text: "ready", mode: "draft" as const };
  it("requires explicit matching account for publishing", () => {
    expect(() => tiktokPostSchema.parse({ ...input, mode: "publish", authorized_channel_id: "other" })).toThrow();
    expect(tiktokPostSchema.parse({ ...input, mode: "publish" }).channel_id).toBe("6b00651cece6dfde5f33640c");
  });
  it("schedule requires a future timestamp", () => {
    expect(() => tiktokPostSchema.parse({ ...input, mode: "schedule", due_at: "2020-01-01T00:00:00Z" })).toThrow();
    expect(() => tiktokPostSchema.parse({ ...input, mode: "schedule" })).toThrow();
  });
  it("same ready clip and account deduplicate across repeated calls", () => {
    expect(tiktokIdemKey(input)).toBe("tiktok:22222222-2222-4222-8222-222222222222:6b00651cece6dfde5f33640c:draft:once");
    expect(tiktokIdemKey({ ...input, mode: "publish" })).not.toBe(tiktokIdemKey(input));
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
