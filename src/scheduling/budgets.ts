import type { BudgetStatus, ResourceBudget, ResourceUsage, UsageObservation } from "../commands/types.ts";

export const emptyUsage = (): ResourceUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0 });

export function validateBudget(budget: ResourceBudget | undefined, scope: string): void {
  if (!budget) return;
  if (!Object.keys(budget).length) throw new Error(`${scope}_BUDGET_INVALID: at least one limit is required`);
  for (const [dimension, limit] of Object.entries(budget)) if (!Number.isSafeInteger(limit) || limit! < 0) throw new Error(`${scope}_BUDGET_INVALID: ${dimension} must be a nonnegative safe integer`);
  if (budget.maxRuns === 0) throw new Error(`${scope}_BUDGET_INVALID: maxRuns must be at least 1`);
}

export function validateUsage(observation: UsageObservation): void {
  for (const dimension of ["inputTokens", "outputTokens", "cachedInputTokens", "costMicros"] as const) if (!Number.isSafeInteger(observation[dimension]) || observation[dimension] < 0) throw new Error(`USAGE_INVALID: ${dimension} must be a nonnegative safe integer`);
  if (observation.cachedInputTokens > observation.inputTokens) throw new Error("USAGE_INVALID: cached input tokens cannot exceed input tokens");
  if (observation.measurement !== "observed" && observation.measurement !== "estimated") throw new Error("USAGE_INVALID: measurement must be observed or estimated");
  if (!observation.provider.trim() || !observation.model.trim()) throw new Error("USAGE_INVALID: provider and model are required");
  if (!Number.isSafeInteger(observation.inputTokens + observation.outputTokens)) throw new Error("USAGE_INVALID: total tokens exceed the safe integer range");
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("USAGE_INVALID: observedAt must be an ISO timestamp");
}

export function sumUsage(observations: UsageObservation[]): ResourceUsage {
  const result = observations.reduce((total, item) => ({ inputTokens: total.inputTokens + item.inputTokens, outputTokens: total.outputTokens + item.outputTokens, cachedInputTokens: total.cachedInputTokens + item.cachedInputTokens, costMicros: total.costMicros + item.costMicros }), emptyUsage());
  for (const [dimension, value] of Object.entries(result)) if (!Number.isSafeInteger(value)) throw new Error(`USAGE_OVERFLOW: ${dimension} exceeds the safe integer range`);
  if (!Number.isSafeInteger(result.inputTokens + result.outputTokens)) throw new Error("USAGE_OVERFLOW: total tokens exceed the safe integer range");
  return result;
}

export function assessBudget(budget: ResourceBudget | undefined, usage: ResourceUsage, input: { startedAt?: string; assessedAt: string; runCount?: number }): BudgetStatus {
  const exceededDimensions: Array<keyof ResourceBudget> = [];
  if (budget) {
    if (budget.inputTokens !== undefined && usage.inputTokens > budget.inputTokens) exceededDimensions.push("inputTokens");
    if (budget.outputTokens !== undefined && usage.outputTokens > budget.outputTokens) exceededDimensions.push("outputTokens");
    if (budget.totalTokens !== undefined && usage.inputTokens + usage.outputTokens > budget.totalTokens) exceededDimensions.push("totalTokens");
    if (budget.costMicros !== undefined && usage.costMicros > budget.costMicros) exceededDimensions.push("costMicros");
    if (budget.elapsedMs !== undefined && input.startedAt && Date.parse(input.assessedAt) - Date.parse(input.startedAt) > budget.elapsedMs) exceededDimensions.push("elapsedMs");
    if (budget.maxRuns !== undefined && (input.runCount ?? 0) > budget.maxRuns) exceededDimensions.push("maxRuns");
  }
  return { state: exceededDimensions.length ? "exceeded" : "active", exceededDimensions, assessedAt: input.assessedAt };
}

export function exhaustedBudgetDimensions(budget: ResourceBudget | undefined, usage: ResourceUsage, input: { startedAt?: string; assessedAt: string; runCount?: number }): Array<keyof ResourceBudget> {
  if (!budget) return [];
  const exhausted: Array<keyof ResourceBudget> = [];
  if (budget.inputTokens !== undefined && usage.inputTokens >= budget.inputTokens) exhausted.push("inputTokens");
  if (budget.outputTokens !== undefined && usage.outputTokens >= budget.outputTokens) exhausted.push("outputTokens");
  if (budget.totalTokens !== undefined && usage.inputTokens + usage.outputTokens >= budget.totalTokens) exhausted.push("totalTokens");
  if (budget.costMicros !== undefined && usage.costMicros >= budget.costMicros) exhausted.push("costMicros");
  if (budget.elapsedMs !== undefined && input.startedAt && Date.parse(input.assessedAt) - Date.parse(input.startedAt) >= budget.elapsedMs) exhausted.push("elapsedMs");
  if (budget.maxRuns !== undefined && (input.runCount ?? 0) >= budget.maxRuns) exhausted.push("maxRuns");
  return exhausted;
}
