// FIXTURE regression tests: in-memory store + fake providers. Not live provider calls, not an e2e MP4.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { processJob, AMBIGUOUS_MSG, type Deps, type Job, type Src, type Store } from "./pipeline.server";
import { ProviderError } from "@/lib/providers/http";

const fixture = (n: string) => new Uint8Array(readFileSync(`src/test/fixtures/${n}`));
const UID = "00000000-0000-0000-0000-000000000001";

function memStore(job: Partial<Job>, sources: Src[] = []) {
  let clock = Date.now();
  const row: Job = { id: "job-1", user_id: UID, status: "queued", stage: "validate", route: "compose", mode: "niche", prompt: "p", language: "en", target_seconds: 40, audio_mode: "voiceover",
    review_before_render: false, approve_sources: false, attempts: 0, render_attempt: 0, plan: null, script: null, caption: null, render_id: null, provider_project_id: null, submit_state: null,
    lease_token: null, lock_until: null, next_attempt_at: new Date(0).toISOString(), deadline_at: new Date(clock + 3600e3).toISOString(), output_path: null, error: null, failed_stage: null, source_id: null, ...job } as Job;
  const uploads = new Set<string>(); const events: string[] = []; const orphans: Record<string, string> = {};
  const store: Store = {
    async lease(_id, token, until) {
      const free = !row.lock_until || new Date(row.lock_until).getTime() < clock;
      if (!["queued", "running"].includes(row.status) || new Date(row.next_attempt_at).getTime() > clock || !free) return null;
      row.lease_token = token; row.lock_until = new Date(until).toISOString();
      return structuredClone(row);
    },
    async update(_j, token, p) {
      if (row.lease_token !== token || !["queued", "running"].includes(row.status)) return false;
      Object.assign(row, p); return true;
    },
    async release(_id, token) { if (row.lease_token === token) { row.lease_token = null; row.lock_until = null; } },
    async recordOrphan(_id, field, id) { if (!row[field]) { (row as any)[field] = id; row.submit_state = "orphaned"; orphans[field] = id; } },
    async log(_j, stage, m) { events.push(`${stage}: ${m}`); },
    async getSource(u, id) { return sources.find((s) => s.id === id && s.user_id === u) ?? null; },
    async library(u) { return sources.filter((s) => s.user_id === u); },
    async upsertStock() { return null; },
    async setSourceDuration() {},
    async signFootage(u, p) { if (!p.startsWith(u + "/")) throw new Error("foreign"); return "https://signed.example/" + p; },
    async uploadOutput(p) { uploads.add(p); },
    async removeOutput(p) { uploads.delete(p); },
  };
  // simulates jobAction("cancel"): status change + lease token cleared
  const cancel = () => { row.status = "cancelled"; row.lease_token = null; row.lock_until = null; };
  return { row, store, uploads, events, orphans, cancel, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

function deps(over: Partial<Deps>, now: () => number): Deps {
  const no = () => { throw new Error("not expected"); };
  return { ai: no as any, tavilyConfigured: () => true, tavilySearch: no as any, pexelsConfigured: () => false, pexelsSearch: no as any, shotstackConfigured: () => true,
    submitRender: no as any, getRender: no as any, probe: async () => 10, vizardConfigured: () => true, vizardSubmit: no as any, vizardQuery: no as any,
    inspectDirectVideo: no as any, fetchOutput: no as any, signJob: async () => "sig", now, ...over };
}
const src = (id: string, user = UID): Src => ({ id, user_id: user, kind: "upload", storage_path: `${user}/a.mp4`, title: "clip", permission: "owned", duration_s: 10 } as any);
const planned = { stage: "render_submit", status: "running", script: "hello", plan: { timeline: [{ source_id: "s1", trim: 0, length: 10 }] } } as Partial<Job>;

describe("fenced pipeline (fixtures)", () => {
  it("cancellation during async AI planning discards the result", async () => {
    const m = memStore({ stage: "research", status: "running" });
    const d = deps({ ai: async () => { m.cancel(); return { search_query: "q" }; }, tavilySearch: async () => [] }, m.now);
    expect(await processJob(m.store, d, "job-1")).toBe("stale");
    expect(m.row.status).toBe("cancelled");
    expect(m.row.stage).toBe("research");
    expect(m.row.plan).toBeNull();
  });

  it("cancellation during finalize never publishes and removes the uploaded file", async () => {
    const m = memStore({ stage: "finalize", status: "running", plan: { render_url: "https://x/out.mp4" } });
    const d = deps({ fetchOutput: async () => { m.cancel(); return fixture("vertical-1080x1920.mp4"); } }, m.now);
    expect(await processJob(m.store, d, "job-1")).toBe("stale");
    expect(m.row.status).toBe("cancelled");
    expect(m.row.output_path).toBeNull();
    expect(m.uploads.size).toBe(0);
  });

  it("stale worker after lease expiry cannot write or clear the new worker's lease", async () => {
    const m = memStore({ stage: "research", status: "running" });
    let release!: (v: any) => void;
    const slow = deps({ ai: () => new Promise((r) => { release = r; }), tavilySearch: async () => [] }, m.now);
    const a = processJob(m.store, slow, "job-1");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    m.tick(130_000); // lease A expired
    let bToken: string | null = null;
    const fast = deps({ ai: async () => { bToken = m.row.lease_token; return { search_query: "B" }; }, tavilySearch: async () => [] }, m.now);
    const bLease = m.store.lease; // B runs fully
    expect(await processJob({ ...m.store, lease: bLease }, fast, "job-1")).toBe("ok");
    expect(bToken).not.toBeNull();
    expect((m.row.plan as any).search_query).toBe("B");
    // now hold a lease for a third worker, then let A finish: A must not overwrite nor release it
    m.row.stage = "research"; m.row.next_attempt_at = new Date(0).toISOString();
    await m.store.lease("job-1", "worker-C", m.now() + 120_000);
    release({ search_query: "A" });
    expect(await a).toBe("stale");
    expect((m.row.plan as any).search_query).toBe("B");
    expect(m.row.lease_token).toBe("worker-C");
  });

  it("ambiguous submission keeps the barrier and is never auto-resubmitted", async () => {
    const m = memStore(planned, [src("s1")]);
    const submit = vi.fn(async () => { throw new ProviderError("Shotstack: сеть/таймаут", 0, true, true); });
    expect(await processJob(m.store, deps({ submitRender: submit }, m.now), "job-1")).toBe("error");
    expect(m.row.status).toBe("failed");
    expect(m.row.submit_state).toBe("submitting");
    expect(m.row.error).toContain("Автоповтор отключён");
    // retry without clearing the barrier (what jobAction does without confirmation is refuse; simulate a resumed worker)
    Object.assign(m.row, { status: "running", next_attempt_at: new Date(0).toISOString() });
    await processJob(m.store, deps({ submitRender: submit }, m.now), "job-1");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(m.row.error).toBe(AMBIGUOUS_MSG("Shotstack"));
  });

  it("crash after barrier (no render_id) blocks auto resubmit after lease expiry", async () => {
    const m = memStore({ ...planned, submit_state: "submitting" }, [src("s1")]);
    const submit = vi.fn(async () => "r-2");
    await processJob(m.store, deps({ submitRender: submit }, m.now), "job-1");
    expect(submit).not.toHaveBeenCalled();
    expect(m.row.status).toBe("failed");
  });

  it("cancel during paid submit stores provider id for reconciliation but does not advance", async () => {
    const m = memStore(planned, [src("s1")]);
    await processJob(m.store, deps({ submitRender: async () => { m.cancel(); return "render-xyz"; } }, m.now), "job-1");
    expect(m.row.status).toBe("cancelled");
    expect(m.row.render_id).toBe("render-xyz");
    expect(m.row.submit_state).toBe("orphaned");
    expect(m.row.stage).toBe("render_submit");
  });

  it("refuses sources that belong to another user", async () => {
    const m = memStore({ source_id: "s9", mode: "link" }, [src("s9", "someone-else")]);
    await processJob(m.store, deps({}, m.now), "job-1");
    expect(m.row.status).toBe("failed");
    expect(m.row.error).toMatch(/другому пользователю/);
  });

  it("finalize verifies real MP4 metadata: accepts 1080x1920 h264+aac, rejects landscape/no-audio", async () => {
    const ok = memStore({ stage: "finalize", status: "running", plan: { render_url: "https://x" } });
    await processJob(ok.store, deps({ fetchOutput: async () => fixture("vertical-1080x1920.mp4") }, ok.now), "job-1");
    expect(ok.row.status).toBe("succeeded");
    expect((ok.row.plan as any).output_meta.video).toEqual({ codec: "avc1", width: 1080, height: 1920 });
    const bad = memStore({ stage: "finalize", status: "running", plan: { render_url: "https://x" } });
    await processJob(bad.store, deps({ fetchOutput: async () => fixture("landscape-noaudio.mp4") }, bad.now), "job-1");
    expect(bad.row.status).toBe("failed");
    expect(bad.uploads.size).toBe(0);
  });

  it("job past its deadline fails instead of running more work", async () => {
    const m = memStore({ stage: "research", status: "running" });
    m.tick(4 * 3600e3);
    await processJob(m.store, deps({}, m.now), "job-1");
    expect(m.row.status).toBe("failed");
    expect(m.row.error).toMatch(/максимальное время/);
  });
});
