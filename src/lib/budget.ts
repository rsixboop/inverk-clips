// Pure rules for raising a story job's spend cap (USD). Only plan.budget_usd changes; a job blocked by
// the spend cap resumes at failed_stage, any other blocked reason stays blocked.
export const MAX_BUDGET_USD = 20;
export const BUDGET_BLOCK_PREFIX = "Лимит расходов задачи";

export function isBudgetBlocked(job: { status: string; error: string | null }) {
  return job.status === "blocked" && (job.error ?? "").startsWith(BUDGET_BLOCK_PREFIX);
}

export function budgetUpdate(job: { route: string; status: string; error: string | null; stage: string; failed_stage: string | null; plan: unknown }, budget: number) {
  if (job.route !== "story") throw new Error("Лимит меняется только у сюжетных задач");
  if (["succeeded", "cancelled"].includes(job.status)) throw new Error("Задача завершена");
  const plan = (job.plan ?? {}) as Record<string, unknown>;
  const spent = Number(plan.spend_usd ?? 0);
  if (!Number.isFinite(budget) || budget <= spent) throw new Error(`Новый лимит должен быть больше потраченного (~$${spent.toFixed(2)})`);
  if (budget > MAX_BUDGET_USD) throw new Error(`Максимальный лимит — $${MAX_BUDGET_USD}`);
  const upd: Record<string, unknown> = { plan: { ...plan, budget_usd: Math.round(budget * 100) / 100 } };
  const resume = isBudgetBlocked(job);
  if (resume) Object.assign(upd, { status: "running", stage: job.failed_stage ?? job.stage, error: null, attempts: 0, finished_at: null });
  return { upd, resume, spent };
}
