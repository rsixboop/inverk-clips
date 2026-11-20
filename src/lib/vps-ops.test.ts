import { describe, expect, it } from "vitest";
import { agentState, failedServices, parseOp } from "./vps-ops";

describe("vps ops allowlist", () => {
  it("rejects operations outside the allowlist, including publishing", () => {
    expect(() => parseOp("buffer.publish", {})).toThrow();
    expect(() => parseOp("shell", { cmd: "rm -rf /" })).toThrow();
  });
  it("rejects extra args and non-reddit urls", () => {
    expect(() => parseOp("sync.now", { x: 1 })).toThrow();
    expect(() => parseOp("reddit.add", { url: "https://evil.example/x" })).toThrow();
    expect(parseOp("reddit.add", { url: "https://www.reddit.com/r/GTA6/comments/abc/x/" }).op).toBe("reddit.add");
  });
  it("bounds collection interval 5..1440 minutes", () => {
    expect(() => parseOp("collect.set_interval", { minutes: 4 })).toThrow();
    expect(() => parseOp("collect.set_interval", { minutes: 1441 })).toThrow();
    expect(parseOp("collect.set_interval", { minutes: 30 }).args).toEqual({ minutes: 30 });
  });
});

describe("agent badge", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  it("never paired / online within 75s / stale after", () => {
    expect(agentState(null, now)).toBe("never");
    expect(agentState({ last_seen_at: "2026-11-20T11:59:00Z" }, now)).toBe("online");
    expect(agentState({ last_seen_at: "2026-11-20T11:58:40Z" }, now)).toBe("stale");
    expect(agentState({ last_seen_at: "2026-11-20T11:59:50Z", revoked_at: "x" }, now)).toBe("revoked");
  });
  it("reports failed services separately", () => {
    expect(failedServices({ "a.service": { active: "active", result: "success" }, "b.service": { active: "failed", result: "exit-code" } })).toEqual(["b.service"]);
  });
});
