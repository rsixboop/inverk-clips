import { describe, expect, it } from "vitest";
import { budgetUpdate } from "./budget";

const tasks = { voice0_s100: { id: "req-1", state: "done" } };
const job = (o: any = {}) => ({ route: "story", status: "blocked", stage: "shot_submit", failed_stage: "shot_submit",
  error: "Лимит расходов задачи: потрачено ~$2.90 из $3.00", plan: { budget_usd: 3, spend_usd: 2.9, provider_tasks: tasks, frames: [{ url: "f" }] }, ...o });

describe("budgetUpdate", () => {
  it("raises cap and resumes at failed_stage keeping assets and provider tasks", () => {
    const { upd, resume } = budgetUpdate(job(), 5);
    expect(resume).toBe(true);
    expect(upd["stage"]).toBe("shot_submit");
    expect(upd["status"]).toBe("running");
    expect((upd["plan"] as any).budget_usd).toBe(5);
    expect((upd["plan"] as any).provider_tasks).toBe(tasks);
    expect((upd["plan"] as any).frames).toEqual([{ url: "f" }]);
  });
  it("rejects a cap not above spent", () => { expect(() => budgetUpdate(job(), 2.9)).toThrow(); });
  it("rejects a cap above $20", () => { expect(() => budgetUpdate(job(), 20.01)).toThrow(); });
  it("does not unblock other blocked reasons", () => {
    const { upd, resume } = budgetUpdate(job({ error: "fal.ai: нет доступа к fal-ai/ffmpeg-api" }), 5);
    expect(resume).toBe(false);
    expect(upd["status"]).toBeUndefined();
  });
  it("rejects non-story jobs", () => { expect(() => budgetUpdate(job({ route: "compose" }), 5)).toThrow(); });
});
