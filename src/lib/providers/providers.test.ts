// FIXTURE tests using documented response shapes; no live calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAL, falSubmit, falPoll, queueBase, scaleInput, captionInput, validMoments } from "./fal";
import { atlasSubmit, atlasPoll, parsePrediction, ttsInput, ATLAS_TTS, imageInput } from "./atlas";
import { parseTavily, tavilySearch } from "./tavily";
import { providerFetch } from "./http";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const response = (data: unknown) => new Response(JSON.stringify(data));
describe("fal and Atlas adapters (fixtures)", () => {
  it("missing FAL_KEY blocks without a network request", async () => {
    vi.stubEnv("FAL_KEY", ""); const f = vi.fn(); vi.stubGlobal("fetch", f);
    await expect(falSubmit(FAL.whisper, {})).rejects.toThrow("FAL_KEY"); expect(f).not.toHaveBeenCalled();
  });
  it("missing ATLAS_CLOUD_API_KEY blocks without a network request", async () => {
    vi.stubEnv("ATLAS_CLOUD_API_KEY", ""); const f = vi.fn(); vi.stubGlobal("fetch", f);
    await expect(atlasSubmit(ATLAS_TTS, ttsInput("Hello"))).rejects.toThrow("ATLAS_CLOUD_API_KEY"); expect(f).not.toHaveBeenCalled();
  });
  it("fal queue uses submit subpath but app-level status/result paths", async () => {
    vi.stubEnv("FAL_KEY", "fixture-only");
    const f = vi.fn().mockResolvedValueOnce(response({ request_id: "r1" })).mockResolvedValueOnce(response({ status: "IN_QUEUE" })).mockResolvedValueOnce(response({ status: "COMPLETED" })).mockResolvedValueOnce(response({ video: { url: "https://v3b.fal.media/out.mp4" } })); vi.stubGlobal("fetch", f);
    expect(await falSubmit(FAL.trim, { video_url: "u" })).toBe("r1");
    expect(await falPoll(FAL.trim, "r1")).toEqual({ state: "processing" });
    expect((await falPoll(FAL.trim, "r1")).state).toBe("done");
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://queue.fal.run/fal-ai/workflow-utilities/trim-video", "https://queue.fal.run/fal-ai/workflow-utilities/requests/r1/status", "https://queue.fal.run/fal-ai/workflow-utilities/requests/r1/status", "https://queue.fal.run/fal-ai/workflow-utilities/requests/r1"]);
    expect(() => queueBase("untrusted/model")).toThrow();
  });
  it("Atlas submits asynchronous TTS and polls prediction", async () => {
    vi.stubEnv("ATLAS_CLOUD_API_KEY", "fixture-only");
    const f = vi.fn().mockResolvedValueOnce(response({ data: { id: "p1", status: "processing" } })).mockResolvedValueOnce(response({ data: { status: "completed", outputs: ["https://media.example/audio.wav"] } })); vi.stubGlobal("fetch", f);
    expect(await atlasSubmit(ATLAS_TTS, ttsInput("Hello"))).toBe("p1");
    expect(await atlasPoll(ATLAS_TTS, "p1")).toEqual({ state: "done", result: { url: "https://media.example/audio.wav" } });
    expect(f.mock.calls[0]?.[0]).toBe("https://api.atlascloud.ai/api/v1/model/generateAudio");
    expect(f.mock.calls[1]?.[0]).toBe("https://api.atlascloud.ai/api/v1/model/prediction/p1");
  });
  it("Atlas handles processing, failed and private outputs", () => {
    expect(parsePrediction({ data: { status: "processing" } })).toEqual({ state: "processing" });
    expect(() => parsePrediction({ data: { status: "failed" } })).toThrow();
    expect(() => parsePrediction({ data: { status: "completed", outputs: ["https://127.0.0.1/private"] } })).toThrow();
  });
  it("vertical output requests exactly 1080x1920 H264 without stretching", () => {
    expect(scaleInput("u")).toMatchObject({ width: 1080, height: 1920, mode: "crop", codec: "libx264" });
  });
  it("subtitle language keeps EN RU UK and a safe vertical offset", () => {
    for (const language of ["en", "ru", "uk"]) expect(captionInput("u", language)).toMatchObject({ language, y_offset: -260, words_per_subtitle: 3 });
  });
  it("TTS preserves script and uses documented economical model", () => {
    expect(ttsInput("Привіт")).toEqual({ model: "google/gemini-2.5-flash-tts", text: "Привіт", voice: "Kore" });
    expect(imageInput("illustration")).toMatchObject({ aspect_ratio: "9:16", enable_sync_mode: false });
  });
  it("moments cannot exceed video bounds or requested duration", () => {
    expect(validMoments([{ start: 40, durationS: 30 }, { start: -1, durationS: 5 }, { start: 0, durationS: 90 }], 50, 20).map((m) => [m.start, m.durationS])).toEqual([[40,10],[0,20]]);
  });
});
describe("safe provider failures and research (fixtures)", () => {
  it("network timeout and submission 500 have unknown outcomes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("reset")));
    await expect(providerFetch("X", "https://x")).rejects.toMatchObject({ ambiguous: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private data", { status: 500 })));
    await expect(providerFetch("X", "https://x", { method: "POST" })).rejects.toMatchObject({ ambiguous: true });
  });
  it("400 is not retryable and does not expose response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private data", { status: 400 })));
    await expect(providerFetch("X", "https://x")).rejects.toMatchObject({ retryable: false, ambiguous: false });
    await expect(providerFetch("X", "https://x")).rejects.not.toThrow("private data");
  });
  it("retains real research URLs, never javascript", () => {
    expect(parseTavily({ results: [{ title: "Fact", url: "https://rockstargames.com", content: "source" }, { url: "javascript:1" }] })).toHaveLength(1);
  });
  it("research sends bearer authorization", async () => {
    vi.stubEnv("TAVILY_API_KEY", "fixture-only"); const f = vi.fn().mockResolvedValue(response({ results: [] })); vi.stubGlobal("fetch", f);
    await tavilySearch("GTA"); expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer fixture-only");
  });
});