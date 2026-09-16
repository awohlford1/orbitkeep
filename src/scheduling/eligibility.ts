import type { AssignmentAggregate, TaskDependency, TaskState } from "../commands/types.ts";
import { emptyUsage, exhaustedBudgetDimensions } from "./budgets.ts";

export type SchedulingBlockCode = "ASSIGNMENT_NOT_RUNNING" | "EXECUTION_AUTHORITY_MISSING" | "AFFECTED_WORK_HELD" | "TASK_NOT_READY" | "DEPENDENCY_MISSING" | "DEPENDENCY_UNSATISFIED" | "DEPENDENCY_TERMINAL_FAILURE" | "GATE_PENDING" | "GATE_FAILED" | "BUDGET_EXHAUSTED" | "RETRY_BACKOFF_ACTIVE" | "DEPENDENCY_CYCLE" | "CONCURRENCY_LIMIT_REACHED";
export interface SchedulingBlock { code: SchedulingBlockCode; taskId: string; dependencyTaskId?: string; detail: string }
export interface SchedulingDecision { eligible: TaskState[]; blocked: Array<{ task: TaskState; reasons: SchedulingBlock[] }> }

const sequence = (task: TaskState, index: number): number => task.createdSequence ?? index + 1;
const dependencies = (task: TaskState): TaskDependency[] => task.dependencies ?? [];

export function validateTaskGraph(tasks: TaskState[]): void {
  const ids = new Set(tasks.map((task) => task.taskId));
  const edges = new Map<string, string[]>();
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const dependency of dependencies(task)) {
      if (dependency.taskId === task.taskId) throw new Error(`TASK_DEPENDENCY_INVALID: ${task.taskId} cannot depend on itself`);
      if (seen.has(dependency.taskId)) throw new Error(`TASK_DEPENDENCY_INVALID: duplicate dependency ${dependency.taskId} on ${task.taskId}`);
      seen.add(dependency.taskId);
      if (dependency.required && !ids.has(dependency.taskId)) throw new Error(`TASK_DEPENDENCY_MISSING: ${dependency.taskId}`);
    }
    edges.set(task.taskId, dependencies(task).filter((item) => item.required && ids.has(item.taskId)).map((item) => item.taskId));
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`TASK_DEPENDENCY_CYCLE: cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) visit(target);
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.taskId);
}

export function schedulingDecision(assignment: AssignmentAggregate, options: { maxConcurrentOperations?: number; now?: Date } = {}): SchedulingDecision {
  validateTaskGraph(assignment.tasks);
  const limit = options.maxConcurrentOperations ?? Number.POSITIVE_INFINITY;
  if ((limit !== Number.POSITIVE_INFINITY && !Number.isInteger(limit)) || limit < 1) throw new Error("SCHEDULING_CONFIGURATION_INVALID: maxConcurrentOperations must be a positive integer");
  const active = assignment.tasks.filter((task) => task.state === "dispatched" || task.state === "running").length;
  let remaining = Math.max(0, limit - active);
  const candidates = assignment.tasks.map((task, index) => ({ task, index })).filter(({ task }) => task.state === "ready");
  candidates.sort((left, right) => (right.task.priority ?? 0) - (left.task.priority ?? 0) || sequence(left.task, left.index) - sequence(right.task, right.index) || left.task.taskId.localeCompare(right.task.taskId));
  const eligible: TaskState[] = [], blocked: SchedulingDecision["blocked"] = [];
  const assessedAt = (options.now ?? new Date()).toISOString();
  const missionBudgetExhausted = exhaustedBudgetDimensions(assignment.budget, assignment.usage ?? emptyUsage(), { ...(assignment.startedAt ? { startedAt: assignment.startedAt } : {}), assessedAt, runCount: assignment.executions.length });
  for (const { task } of candidates) {
    const reasons: SchedulingBlock[] = [];
    if (task.affectedPaths.some((path) => assignment.holds.includes(path))) reasons.push({ code: "AFFECTED_WORK_HELD", taskId: task.taskId, detail: "One or more affected paths are held" });
    for (const gate of (task.gates ?? []).filter((item) => item.required && item.phase === "pre_dispatch" && !["passed", "waived"].includes(item.status))) reasons.push({ code: gate.status === "failed" ? "GATE_FAILED" : "GATE_PENDING", taskId: task.taskId, detail: `Required gate ${gate.gateId} is ${gate.status}` });
    if (missionBudgetExhausted.length) reasons.push({ code: "BUDGET_EXHAUSTED", taskId: task.taskId, detail: `Mission budget exhausted: ${missionBudgetExhausted.join(", ")}` });
    const runBudgetExhausted = exhaustedBudgetDimensions(task.runBudget, emptyUsage(), { assessedAt, runCount: 0 });
    if (runBudgetExhausted.length) reasons.push({ code: "BUDGET_EXHAUSTED", taskId: task.taskId, detail: `Run budget exhausted: ${runBudgetExhausted.join(", ")}` });
    if (task.retryState?.status === "scheduled" && task.retryState.nextAttemptAt && Date.parse(task.retryState.nextAttemptAt) > Date.parse(assessedAt)) reasons.push({ code: "RETRY_BACKOFF_ACTIVE", taskId: task.taskId, detail: `Retry is not eligible before ${task.retryState.nextAttemptAt}` });
    if (assignment.lifecycle !== "running") reasons.push({ code: "ASSIGNMENT_NOT_RUNNING", taskId: task.taskId, detail: `Mission is ${assignment.lifecycle}` });
    if (assignment.executionAuthority.state !== "authorized") reasons.push({ code: "EXECUTION_AUTHORITY_MISSING", taskId: task.taskId, detail: `Execution authority is ${assignment.executionAuthority.state}` });
    for (const dependency of dependencies(task)) {
      const target = assignment.tasks.find((candidate) => candidate.taskId === dependency.taskId);
      if (!target) { if (dependency.required) reasons.push({ code: "DEPENDENCY_MISSING", taskId: task.taskId, dependencyTaskId: dependency.taskId, detail: "Required dependency does not exist" }); continue; }
      if (!dependency.required) continue;
      if (target.state === "cancelled" || target.state === "skipped") reasons.push({ code: "DEPENDENCY_TERMINAL_FAILURE", taskId: task.taskId, dependencyTaskId: dependency.taskId, detail: `Required dependency was ${target.state}` });
      else if (!dependency.acceptableStates.includes(target.state as "accepted" | "closed")) reasons.push({ code: "DEPENDENCY_UNSATISFIED", taskId: task.taskId, dependencyTaskId: dependency.taskId, detail: `Required dependency is ${target.state}` });
    }
    if (reasons.length === 0 && remaining === 0) reasons.push({ code: "CONCURRENCY_LIMIT_REACHED", taskId: task.taskId, detail: `Active Operation limit ${limit} reached` });
    if (reasons.length === 0) { eligible.push(structuredClone(task)); remaining -= 1; } else blocked.push({ task: structuredClone(task), reasons });
  }
  return { eligible, blocked };
}

export function assertTaskDispatchEligible(assignment: AssignmentAggregate, taskId: string, options: { maxConcurrentOperations?: number; now?: Date } = {}): void {
  const task = assignment.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error("Task not found");
  if (task.state !== "ready") throw new Error(`TASK_NOT_READY: task is ${task.state}`);
  const decision = schedulingDecision(assignment, options);
  if (decision.eligible.some((candidate) => candidate.taskId === taskId)) return;
  const reason = decision.blocked.find((item) => item.task.taskId === taskId)?.reasons[0];
  throw new Error(`${reason?.code ?? "TASK_NOT_ELIGIBLE"}: ${reason?.detail ?? "task cannot dispatch"}`);
}
