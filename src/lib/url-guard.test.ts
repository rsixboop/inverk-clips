import { describe, expect, it } from "vitest";
import { classifyUrl, isPrivateIp, parsePublicUrl } from "./url-guard";

describe("url guard", () => {
  it("rejects http, localhost and private IPs", () => {
    expect(() => parsePublicUrl("http://example.com/a.mp4")).toThrow();
    expect(() => parsePublicUrl("https://localhost/a.mp4")).toThrow();
    expect(() => parsePublicUrl("https://10.0.0.5/a.mp4")).toThrow();
    expect(() => parsePublicUrl("https://169.254.169.254/latest")).toThrow();
  });
  it("detects private ranges", () => {
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.20.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });
  it("classifies sources", () => {
    expect(classifyUrl(parsePublicUrl("https://cdn.example.com/x.mp4"))).toBe("direct_url");
    expect(classifyUrl(parsePublicUrl("https://www.youtube.com/watch?v=abc"))).toBe("youtube");
    expect(classifyUrl(parsePublicUrl("https://www.youtube.com/@rockstargames"))).toBe("channel");
    expect(classifyUrl(parsePublicUrl("https://www.twitch.tv/videos/123"))).toBe("twitch");
    expect(classifyUrl(parsePublicUrl("https://www.twitch.tv/somestreamer"))).toBe("channel");
    expect(classifyUrl(parsePublicUrl("https://example.com/article"))).toBe("page");
  });
});
