// Fixture tests (provider responses copied from official docs shapes) — NOT live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSubmit, parseQuery, parseSubmit, preferLength, vizardSubmit } from "./vizard";
import { parseTavily, tavilySearch } from "./tavily";
import { parsePexels } from "./pexels";
import { ProviderError, providerFetch } from "./http";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("vizard adapter", () => {
  it("maps target length to documented preferLength", () => {
    expect(preferLength(25)).toEqual([1]); expect(preferLength(40)).toEqual([2]); expect(preferLength(75)).toEqual([3]);
  });
  it("YouTube uses videoType 2 without ext; direct file uses 1 with ext; Twitch 9", () => {
    const yt = buildSubmit({ url: "https://youtu.be/x", kind: "youtube", lang: "en", seconds: 40, keywords: "gta", name: "n" });
    expect(yt).toMatchObject({ videoType: 2, ratioOfClip: 1, subtitleSwitch: 1, lang: "en" });
    expect("ext" in yt).toBe(false);
    expect(buildSubmit({ url: "https://a/b.mp4", kind: "direct_url", lang: "en", seconds: 40, keywords: "", name: "n" })).toMatchObject({ videoType: 1, ext: "mp4" });
    expect(buildSubmit({ url: "https://twitch.tv/videos/1", kind: "twitch", lang: "ru", seconds: 40, keywords: "", name: "n" }).videoType).toBe(9);
  });
  it("parses processing / done / error", () => {
    expect(parseQuery({ code: 1000 })).toEqual({ state: "processing" });
    const done = parseQuery({ code: 2000, videos: [{ videoId: 1, videoUrl: "https://cdn/x.mp4", videoMsDuration: 41000, title: "T", transcript: "hi", viralScore: "8" }] });
    expect(done.state).toBe("done");
    if (done.state === "done") expect(done.clips[0]).toMatchObject({ durationS: 41, viralScore: 8 });
    expect(() => parseQuery({ code: 4007 })).toThrow(/закончилось время/);
    expect(parseSubmit({ code: 2000, projectId: 17861706 })).toBe("17861706");
  });
  it("rate limit is retryable, invalid key is not", () => {
    try { parseQuery({ code: 4003 }); } catch (e) { expect((e as ProviderError).retryable).toBe(true); }
    try { parseQuery({ code: 4001 }); } catch (e) { expect((e as ProviderError).retryable).toBe(false); }
  });
  it("absent key blocks without any network call", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f); vi.stubEnv("VIZARD_API_KEY", "");
    await expect(vizardSubmit(buildSubmit({ url: "u", kind: "youtube", lang: "en", seconds: 40, keywords: "", name: "n" }))).rejects.toThrow(/Не подключено/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("http", () => {
  it("network failure is ambiguous (never auto-resubmitted)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("reset")));
    await expect(providerFetch("X", "https://x")).rejects.toMatchObject({ ambiguous: true });
  });
  it("500 is retryable, 400 is not", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 500 })));
    await expect(providerFetch("X", "https://x")).rejects.toMatchObject({ retryable: true, ambiguous: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad", { status: 400 })));
    await expect(providerFetch("X", "https://x")).rejects.toMatchObject({ retryable: false });
  });
});

describe("tavily + pexels", () => {
  it("keeps only real http(s) result URLs", () => {
    expect(parseTavily({ results: [{ title: "a", url: "https://rockstargames.com/x", content: "c", score: 0.9 }, { title: "b", url: "javascript:1" }] })).toHaveLength(1);
  });
  it("sends bearer auth", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal("fetch", f); vi.stubEnv("TAVILY_API_KEY", "k");
    await tavilySearch("gta");
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer k");
  });
  it("picks the smallest mp4 that is still >=1080 short side", () => {
    const [c] = parsePexels({ videos: [{ id: 5, url: "https://www.pexels.com/video/night-city-5/", image: "i", duration: 12, user: { name: "A" },
      video_files: [{ link: "s", width: 540, height: 960, file_type: "video/mp4" }, { link: "hd", width: 1080, height: 1920, file_type: "video/mp4" }, { link: "4k", width: 2160, height: 3840, file_type: "video/mp4" }] }] });
    expect(c).toMatchObject({ fileUrl: "hd", title: "night city", duration: 12 });
  });
});
