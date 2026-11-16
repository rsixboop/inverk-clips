// Story route: plan validator, narrator timing, mixer and staged state machine (fixtures, no live calls).
import { describe, expect, it, vi } from "vitest";
import { alignVoice, normalizePlan, validatePlan, STORY_BUDGET_USD } from "./story-plan";
import { decodeWav, encodeWav16, mixNarratorFirst, wavDuration } from "@/lib/wav";
import { narrationCoverage } from "./story.server";
import { processJob, type Deps, type Job, type Store } from "./pipeline.server";
import { readFileSync } from "node:fs";
import { FAL, readCapability } from "@/lib/providers/fal";
import { inspectMp4 } from "@/lib/mp4-inspect";
import { muxClipsWithPcm, readVideoTrack } from "@/lib/mp4-mux";

const scene = (o: any = {}) => ({ purpose: "p", where: "Los Santos street, midday", who: ["actor"], action: "runs to the garage", camera: "third-person chase cam",
  start_state: { car: "outside", door: "open" }, end_state: { car: "outside", door: "open" }, changes: [], props: "", narration: "I needed a place.", narration_support: ["action"],
  sound: "footsteps", sound_events: [], reveals_payoff: false, ...o });
const good = () => ({
  candidates: [{ id: "a", synopsis: "s", goal: "g", obstacle: "o", action: "a", consequence: "c", hook_promise: "h", hook_visual: "v", payoff: "p", withheld: "w", reason: "r" }, { id: "b", synopsis: "s2" }],
  selected_id: "a", title: "T", caption: "c", hashtags: ["gta"], payoff_terms: ["outside"],
  anchors: { actor: { id: "hero", description: "man in white tee" }, vehicle: { id: "car", description: "green sedan" } },
  scenes: [scene(), scene({ action: "pulls the door down", end_state: { car: "outside", door: "closed" }, changes: [{ key: "door", by: "pulls the door down" }], narration: "The door shut." }),
    scene({ start_state: { car: "outside", door: "closed" }, end_state: { car: "outside", door: "closed" }, action: "exhales in relief", narration: "Finally, safe." }),
    scene({ start_state: { car: "outside", door: "closed" }, end_state: { car: "outside", door: "closed" }, action: "police surround the car", narration: "I left the car outside.", narration_support: ["car"], reveals_payoff: true })],
});

describe("story plan validator", () => {
  it("accepts a coherent 4-scene plan", () => expect(validatePlan(normalizePlan(good()))).toEqual([]));
  it("flags a door that reopens across a cut without an action", () => {
    const g = good(); g.scenes[2]!.start_state = { car: "outside", door: "open" }; g.scenes[2]!.end_state = { car: "outside", door: "open" }; g.scenes[3]!.start_state.door = "open"; g.scenes[3]!.end_state.door = "open";
    expect(validatePlan(normalizePlan(g)).join(" ")).toMatch(/door" jumps from closed to open/);
  });
  it("flags car inside→outside inside a shot with no causing action", () => {
    const g = good(); g.scenes[0]!.start_state = { car: "inside", door: "open" };
    expect(validatePlan(normalizePlan(g)).join(" ")).toMatch(/"car" changes inside → outside with no on-screen action/);
  });
  it("flags a premature reveal in narration", () => {
    const g = good(); g.scenes[1]!.narration = "The car stayed outside.";
    expect(validatePlan(normalizePlan(g)).join(" ")).toMatch(/gives the payoff away early/);
  });
  it("flags narration not supported by what is shown", () => {
    const g = good(); g.scenes[2]!.narration_support = ["sirens"];
    expect(validatePlan(normalizePlan(g)).join(" ")).toMatch(/support "sirens" is not shown/);
  });
  it("flags too many actions in one 5s scene", () => {
    const g = good(); g.scenes[0]!.action = "jumps out, then runs, then rolls under the door";
    expect(validatePlan(normalizePlan(g)).join(" ")).toMatch(/too many actions/);
  });
});

describe("narrator-first timing", () => {
  it("fits lines in 5s scenes and keeps a silent ~2s final reveal", () => {
    const a = alignVoice([2.0, 3.1, 4.0, 2.5]);
    expect(a.ok).toBe(true); expect(a.total).toBe(20);
    expect(a.slots[3]!.end).toBeLessThanOrEqual(18.1);
  });
  it("rejects a final line that would eat the reveal", () => expect(alignVoice([2, 2, 2, 3.5]).ok).toBe(false));
});

describe("mixer", () => {
  const tone = (sec: number, amp: number, rate = 24000) => { const x = new Float32Array(sec * rate); for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(i / 3); return encodeWav16(x, rate); };
  it("decodes WAV duration", () => expect(wavDuration(tone(2, 0.5))).toBeCloseTo(2, 2));
  it("ducks SFX ≥10 dB under the voice and keeps peak at -1 dBFS", () => {
    const m = mixNarratorFirst([{ pcm: decodeWav(tone(2, 0.5)), at: 1 }], [{ pcm: decodeWav(tone(5, 0.5)), at: 0 }], 5);
    expect(m.stats.peakDb).toBeCloseTo(-1, 1);
    expect(m.stats.voiceRmsDb - m.stats.sfxUnderVoiceDb).toBeGreaterThanOrEqual(10);
  });
  it("measures narration coverage from the subtitle transcription", () => {
    expect(narrationCoverage("The door shut. The sirens faded.", "the door shut the sirens faded")).toBe(1);
    expect(narrationCoverage("The door shut. The sirens faded.", "")).toBe(0);
  });
});

describe("story state machine (fixtures)", () => {
  function mem(job: Partial<Job>, wavAsset: Uint8Array = new Uint8Array(), uploads: string[] = []) {
    const row = { id: "j", user_id: "u", status: "running", stage: "validate", route: "story", workflow_version: 2, prompt: "gta", language: "en", attempts: 0, render_attempt: 0,
      plan: { budget_usd: STORY_BUDGET_USD, spend_usd: 0 }, next_attempt_at: new Date(0).toISOString(), deadline_at: new Date(Date.now() + 3600e3).toISOString(), lock_until: null, lease_token: null, ...job } as any as Job;
    const store: Store = {
      async lease(_i, t, u) { if (!["queued", "running"].includes(row.status) || row.lease_token) return null; row.lease_token = t; row.lock_until = new Date(u).toISOString(); return structuredClone(row); },
      async update(_j, t, p) { if (row.lease_token !== t || !["queued", "running"].includes(row.status)) return false; Object.assign(row, p); return true; },
      async release(_i, t) { if (row.lease_token === t) { row.lease_token = null; row.lock_until = null; } },
      async recordOrphan() {}, async log() {}, async getSource() { return null; }, async library() { return []; }, async setSourceDuration() {},
      async signFootage() { return ""; }, async uploadOutput() {}, async removeOutput() {}, async uploadAsset(p: string) { uploads.push(p); }, async signAsset(p) { return "https://s/" + p; }, async downloadAsset() { return wavAsset; },
    };
    return { row, store, uploads };
  }
  const deps = (o: Partial<Deps>): Deps => ({ ai: vi.fn(), tavilyConfigured: () => true, tavilySearch: vi.fn() as any, falConfigured: () => true, atlasConfigured: () => false,
    falSubmit: vi.fn() as any, falPoll: vi.fn() as any, atlasSubmit: vi.fn() as any, atlasPoll: vi.fn() as any, inspectDirectVideo: vi.fn() as any, fetchOutput: vi.fn() as any, fetchMedia: vi.fn() as any, signJob: async () => "", now: () => Date.now(), ...o });

  it("validate → story_plan without footage, then repairs an invalid plan before any paid call", async () => {
    const m = mem({}); const d = deps({ ai: vi.fn(async () => ({ ...good(), scenes: good().scenes.slice(0, 3) })) });
    await processJob(m.store, d, "j"); expect(m.row.stage).toBe("story_plan");
    await processJob(m.store, d, "j");
    expect((m.row.plan as any).story_repairs).toBe(1); expect(m.row.stage).toBe("story_plan");
    expect(d.falSubmit).not.toHaveBeenCalled();
  });
  it("valid plan stores selection metadata and moves to narrator TTS", async () => {
    const m = mem({ stage: "story_plan" }); await processJob(m.store, deps({ ai: async () => good() }), "j");
    const p = m.row.plan as any;
    expect(m.row.stage).toBe("voice_submit"); expect(p.story_summary.payoff).toBe("p"); expect(p.calibration_version).toMatch(/^story-v/);
    expect(m.row.script).toContain("I left the car outside.");
  });
  it("voice submit is idempotent: a stored provider ID is never resubmitted", async () => {
    const m = mem({ stage: "story_plan" }); await processJob(m.store, deps({ ai: async () => good() }), "j");
    const submit = vi.fn(async () => "req-1"); const d = deps({ falSubmit: submit });
    await processJob(m.store, d, "j"); expect(m.row.stage).toBe("voice_wait");
    m.row.stage = "voice_submit"; m.row.next_attempt_at = new Date(0).toISOString();
    await processJob(m.store, d, "j"); expect(submit).toHaveBeenCalledTimes(1); expect(m.row.stage).toBe("voice_wait");
    expect((m.row.plan as any).spend_usd).toBeCloseTo(0.01, 3);
  });
  it("per-job spend cap blocks a paid call that would exceed the budget", async () => {
    const m = mem({ stage: "story_plan" }); await processJob(m.store, deps({ ai: async () => good() }), "j");
    (m.row.plan as any).spend_usd = 2.995;
    const submit = vi.fn(async () => "x"); await processJob(m.store, deps({ falSubmit: submit }), "j");
    expect(submit).not.toHaveBeenCalled(); expect(m.row.status).toBe("blocked"); expect(m.row.error).toMatch(/Лимит расходов/);
  });
  it("silent narrator line fails the job instead of continuing", async () => {
    const silent = encodeWav16(new Float32Array(2400), 24000);
    const m = mem({ stage: "story_plan" }); await processJob(m.store, deps({ ai: async () => good() }), "j");
    const d = deps({ falSubmit: async () => "r1", falPoll: async () => ({ state: "done", result: { audio: { url: "https://v3.fal.media/a.wav" } } }) as any, fetchMedia: async () => silent });
    await processJob(m.store, d, "j"); m.row.next_attempt_at = new Date(0).toISOString();
    await processJob(m.store, d, "j");
    expect(m.row.status).toBe("failed"); expect(m.row.error).toMatch(/пустая/);
  });
  it("REGRESSION 50e227d5: fal 422 no_media_generated on a frame result → one compact retry under a new key, earlier assets reused", async () => {
    const { ProviderError, classifyProviderError, humanProviderError } = await import("@/lib/providers/http");
    const d422 = classifyProviderError(422, JSON.stringify({ detail: [{ loc: ["body"], msg: "The model did not generate the expected output", type: "no_media_generated", input: { prompt: "secret-ish long prompt" } }] }));
    const m = mem({ stage: "story_plan" }); await processJob(m.store, deps({ ai: async () => good() }), "j");
    Object.assign(m.row, { stage: "frame_wait", next_attempt_at: new Date(0).toISOString() });
    Object.assign(m.row.plan as any, { cur: 1, retry: 0, spend_usd: 0.16, voices: [{ url: "v" }], frames: [{ url: "https://v3b.fal.media/f0.png" }],
      provider_tasks: { voice0_s100: { state: "done", id: "v0" }, frame0_r0: { state: "done", id: "f0" }, frame1_r0: { provider: "fal", model: "fal-ai/nano-banana/edit", state: "submitted", id: "f1", submitted_at: Date.now() } } });
    const submit = vi.fn(async () => "f1-retry");
    const d = deps({ falPoll: async () => { throw new ProviderError(humanProviderError("fal.ai", d422), 422, false, false, d422); }, falSubmit: submit });
    await processJob(m.store, d, "j");
    const p = m.row.plan as any;
    expect(m.row.status).toBe("running"); expect(m.row.error).toBeFalsy(); expect(m.row.stage).toBe("frame_submit"); expect(p.retry).toBe(1); expect(p.compact_prompt).toBe(true);
    expect(p.provider_tasks.frame1_r0.state).toBe("failed"); expect(p.provider_errors.at(-1)).toMatchObject({ kind: "no_media", status: 422, types: ["no_media_generated"], fields: ["body"] });
    expect(JSON.stringify(p.provider_errors)).not.toContain("secret-ish");
    m.row.next_attempt_at = new Date(0).toISOString(); await processJob(m.store, d, "j");
    expect(submit).toHaveBeenCalledTimes(1); expect((submit.mock.calls[0] as any)[0]).toBe("fal-ai/nano-banana/edit");
    expect(((submit.mock.calls[0] as any)[1]).prompt.length).toBeLessThan(400);
    expect(m.row.stage).toBe("frame_wait"); expect((m.row.plan as any).provider_tasks.frame1_r1.id).toBe("f1-retry");
    expect((m.row.plan as any).provider_tasks.frame0_r0.id).toBe("f0");
  });
  it("a second no_media for the same frame fails visibly without a third paid call", async () => {
    const { ProviderError, classifyProviderError } = await import("@/lib/providers/http");
    const d422 = classifyProviderError(422, JSON.stringify({ detail: [{ type: "no_media_generated", msg: "x" }] }));
    const m = mem({ stage: "story_plan" }); await processJob(m.store, deps({ ai: async () => good() }), "j");
    Object.assign(m.row, { stage: "frame_wait", next_attempt_at: new Date(0).toISOString() });
    Object.assign(m.row.plan as any, { cur: 1, retry: 1, frames: [{ url: "u" }], provider_tasks: { frame1_r1: { provider: "fal", model: "fal-ai/nano-banana/edit", state: "submitted", id: "f", submitted_at: Date.now() } } });
    const submit = vi.fn(); await processJob(m.store, deps({ falPoll: async () => { throw new ProviderError("no media", 422, false, false, d422); }, falSubmit: submit as any }), "j");
    expect(m.row.status).toBe("failed"); expect(submit).not.toHaveBeenCalled();
  });
});

describe("REGRESSION 50e227d5 (2): fal-ai/ffmpeg-api 403 on metadata → permitted renderer, completed assets reused", () => {
  const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../test/fixtures/${n}`, import.meta.url)));
  const ok = (models: string[]) => Promise.resolve(models.map((model) => ({ model, ok: true, status: 422, reason: "доступен" })));
  function midJob(extra: any = {}) {
    return { stage: "shot_check_submit", next_attempt_at: new Date(0).toISOString(), plan: { budget_usd: STORY_BUDGET_USD, spend_usd: 0.715, story: normalizePlan(good()), cur: 0, retry: 0,
      voices: [1, 2, 3, 4].map(() => ({ url: "v", duration: 2 })), frames: [0, 1, 2, 3].map((i) => ({ url: `https://v3b.fal.media/f${i}.png` })), shots: [], shot_candidate: "https://v3b.fal.media/shot0.mp4",
      provider_tasks: { voice0_s100: { state: "done", id: "v0" }, frame0_r0: { state: "done", id: "f0" }, shot0_r0: { provider: "fal", model: FAL.i2v, state: "done", id: "kling0" },
        shotmeta0_r0: { provider: "fal", model: FAL.metadata, state: "submitted", id: "denied-meta" } }, ...extra } } as any;
  }
  it("classifies an endpoint 403 as forbidden (named endpoint), never as an invalid key; 401 stays auth", async () => {
    const { classifyProviderError: c, humanProviderError: h } = await import("@/lib/providers/http");
    const d = c(403, JSON.stringify({ detail: "Access denied: You do not have permission to use this endpoint" }));
    expect(d.kind).toBe("forbidden");
    const msg = h("fal.ai fal-ai/ffmpeg-api/metadata", d);
    expect(msg).toContain("fal-ai/ffmpeg-api/metadata"); expect(msg).not.toMatch(/Проверьте ключ/);
    expect(c(403, JSON.stringify({ detail: "Endpoint x is not available: no billing definition.", type: "endpoint_not_priced" })).kind).toBe("forbidden");
    expect(c(401, JSON.stringify({ detail: "Invalid key" })).kind).toBe("auth");
  });
  it("capability probe maps 422→usable, 403→denied, 401→bad key, network→unknown", () => {
    expect(readCapability("m", 422, "").ok).toBe(true);
    expect(readCapability("m", 403, "Access denied").ok).toBe(false);
    expect(readCapability("m", 401, "").reason).toMatch(/401/);
    expect(readCapability("m", 0, "").ok).toBeNull();
  });
  it("resumes at the end-frame check with extract-nth-frame; voice/frames/Kling shot are not resubmitted", async () => {
    const m = mem(midJob());
    const submit = vi.fn(async () => "frames-req"), shot = fx("shot-5s-a.mp4");
    const d = deps({ falSubmit: submit as any, falCapabilities: ok, falPoll: async () => ({ state: "done", result: { images: [{ url: "https://v3b.fal.media/a.png" }, { url: "https://v3b.fal.media/last.png" }], frame_count: 2 } }) as any,
      fetchMedia: async () => shot, ai: async () => ({ checks: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ i, pass: true })) }) });
    await processJob(m.store, d, "j");
    expect(submit).toHaveBeenCalledTimes(1); expect((submit.mock.calls[0] as any)[0]).toBe(FAL.frames);
    expect(m.row.stage).toBe("shot_check_wait");
    m.row.next_attempt_at = new Date(0).toISOString(); await processJob(m.store, d, "j");
    const p = m.row.plan as any;
    expect(m.row.status).toBe("running"); expect(m.row.stage).toBe("shot_submit"); expect(p.cur).toBe(1);
    expect(p.shots[0]).toMatchObject({ url: "https://v3b.fal.media/shot0.mp4", end_frame: "https://v3b.fal.media/last.png" }); expect(p.shots[0].duration).toBeCloseTo(5, 0);
    expect(p.provider_tasks.shot0_r0.id).toBe("kling0"); expect(p.provider_tasks.frame0_r0.id).toBe("f0");
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("preflight blocks before a paid call when a downstream renderer endpoint is denied", async () => {
    const m = mem(midJob()); m.row.stage = "shot_submit"; (m.row.plan as any).cur = 1;
    const submit = vi.fn(async () => "x");
    const caps = async (models: string[]) => models.map((model) => ({ model, ok: model !== FAL.captions, status: model === FAL.captions ? 403 : 422, reason: model === FAL.captions ? "нет доступа к эндпоинту для этого аккаунта fal (403)" : "доступен" }));
    await processJob(m.store, deps({ falSubmit: submit as any, falCapabilities: caps }), "j");
    expect(submit).not.toHaveBeenCalled(); expect(m.row.status).toBe("blocked");
    expect(m.row.error).toContain(FAL.captions); expect((m.row.plan as any).spend_usd).toBe(0.715);
  });
  it("remux joins scaled shots + narrator WAV in-Worker into a playable MOV for scale-video", async () => {
    const tone = new Float32Array(24000 * 20).map((_, i) => 0.3 * Math.sin(i / 5));
    const m = mem({ ...midJob(), stage: "remux" }, encodeWav16(tone, 24000));
    Object.assign(m.row.plan as any, { mix_path: "u/j/mix_r0.wav", shots: [0, 1, 2, 3].map((i) => ({ url: `s${i}`, scaled_url: `https://v3b.fal.media/sc${i}.mp4` })) });
    const clips = [fx("shot-5s-a.mp4"), fx("shot-5s-b.mp4")]; let k = 0;
    await processJob(m.store, deps({ falCapabilities: ok, fetchMedia: async () => clips[k++ % 2]! }), "j");
    expect(m.row.stage).toBe("scale_submit"); expect(m.uploads[0]).toMatch(/assembled_r\d+\.mov$/);
    expect((m.row.plan as any).composed_url).toContain("assembled_");
  });
  it("muxer output: one H.264 track with all samples + PCM narration, duration = sum of clips", () => {
    const a = fx("shot-5s-a.mp4"), b = fx("shot-5s-b.mp4");
    const out = muxClipsWithPcm([a, b], { samples: new Float32Array(24000 * 10), rate: 24000 });
    const info = inspectMp4(out); const t = readVideoTrack(out);
    expect(info.video?.codec).toMatch(/^avc1$/); expect(info.audio?.codec).toBe("sowt");
    expect(t.samples.length).toBe(readVideoTrack(a).samples.length + readVideoTrack(b).samples.length);
    expect(info.durationS).toBeCloseTo(10, 0);
  });
});

describe("provider error classification", () => {
  it("distinguishes validation, no-output, auth, credits and rate limits; never echoes inputs or keys", async () => {
    const { classifyProviderError: c, humanProviderError: h } = await import("@/lib/providers/http");
    expect(c(422, JSON.stringify({ detail: [{ type: "no_media_generated", msg: "m", loc: ["body"] }] })).kind).toBe("no_media");
    const v = c(422, JSON.stringify({ detail: [{ type: "value_error", msg: "bad url", loc: ["body", "image_urls", 0] }] }));
    expect(v).toMatchObject({ kind: "validation", fields: ["body.image_urls.0"] }); expect(h("fal.ai", v)).toMatch(/параметры/);
    expect(c(401, "Unauthorized").kind).toBe("auth"); expect(c(403, "User is locked. Reason: Exhausted balance").kind).toBe("credits");
    expect(c(429, "").kind).toBe("rate_limit"); expect(c(503, "").kind).toBe("server");
    expect(h("fal.ai", c(422, JSON.stringify({ detail: [{ type: "no_media_generated" }] })))).not.toMatch(/баланс сервиса/);
    expect(c(400, "Key abc.def leaked").messages[0]).not.toContain("abc.def");
  });
});
