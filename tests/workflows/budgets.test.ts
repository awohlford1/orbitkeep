import assert from "node:assert/strict";
import test from "node:test";
import defaults from "../../defaults/config.json" with { type: "json" };
import type { FrameworkConfiguration } from "../../src/contracts/configuration.ts";
import { MemoryWorkflowRepository, WorkflowCommandService, type ResourceBudget } from "../../src/commands/index.ts";

const manager = { actor: { actorId: "manager-1", actorType: "manager" as const }, managerInstanceId: "mgr-1" };
const executive = { actorId: "executive-1", actorType: "executive" as const };
const adapter = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-1", valid: true }; }, async transferOwnership() { return { accepted: true }; } };

async function fixture(budget?: ResourceBudget) {
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter);
  const started = await service.start({ objective: "Budget work", approach: ["measure"], acceptanceCriteria: ["bounded"], waiveApproval: true, ...(budget ? { budget } : {}) }, { ...manager, actor: executive });
  const context = { ...manager, ownershipToken: started.assignment.ownershipLease!.token };
  return { repository, service, started, context };
}

async function running(f: Awaited<ReturnType<typeof fixture>>, runBudget?: ResourceBudget) {
  const task = await f.service.createTask(f.started.assignment.assignmentId, [], f.context, runBudget ? { runBudget } : {});
  await f.service.transitionTask(f.started.assignment.assignmentId, task.taskId, "ready", f.context);
  const execution = await f.service.beginExecution(f.started.assignment.assignmentId, task.taskId, f.context);
  return { task, execution };
}

const observation = (taskId: string, executionId: string, overrides: Record<string, unknown> = {}) => ({ observationId: "uobs-one", taskId, executionId, provider: "test-provider", model: "test-model", measurement: "observed" as const, inputTokens: 4, outputTokens: 6, cachedInputTokens: 2, costMicros: 100, observedAt: "2026-09-15T12:00:01.000Z", ...overrides });

test("a Mission may complete usage exactly at its limit but cannot dispatch more work", async () => {
  const f = await fixture({ totalTokens: 10 });
  const first = await running(f);
  await f.service.recordUsageObservation(f.started.assignment.assignmentId, observation(first.task.taskId, first.execution.executionId), f.context);
  const current = await f.repository.get(f.started.assignment.assignmentId);
  assert.equal(current?.budgetStatus?.state, "active");
  assert.deepEqual(current?.usage, { inputTokens: 4, outputTokens: 6, cachedInputTokens: 2, costMicros: 100 });
  const second = await f.service.createTask(f.started.assignment.assignmentId, [], f.context);
  await f.service.transitionTask(f.started.assignment.assignmentId, second.taskId, "ready", f.context);
  await assert.rejects(f.service.beginExecution(f.started.assignment.assignmentId, second.taskId, f.context), /BUDGET_EXHAUSTED/);
});

test("a Run overrun holds the Mission and blocks the active Operation", async () => {
  const f = await fixture();
  const active = await running(f, { costMicros: 50 });
  await f.service.recordUsageObservation(f.started.assignment.assignmentId, observation(active.task.taskId, active.execution.executionId), f.context);
  const current = await f.repository.get(f.started.assignment.assignmentId);
  assert.equal(current?.lifecycle, "blocked");
  assert.equal(current?.executionAuthority.state, "held");
  assert.equal(current?.tasks[0]?.state, "blocked");
  assert.deepEqual(current?.executions[0]?.budgetStatus?.exceededDimensions, ["costMicros"]);
});

test("estimated observations count and immutable observation IDs are idempotent", async () => {
  const f = await fixture({ inputTokens: 20 });
  const active = await running(f);
  const item = observation(active.task.taskId, active.execution.executionId, { measurement: "estimated" as const });
  const first = await f.service.recordUsageObservation(f.started.assignment.assignmentId, item, f.context);
  const second = await f.service.recordUsageObservation(f.started.assignment.assignmentId, item, f.context);
  assert.deepEqual(second, first);
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.usageObservations?.length, 1);
  await assert.rejects(f.service.recordUsageObservation(f.started.assignment.assignmentId, { ...item, costMicros: 101 }, f.context), /USAGE_OBSERVATION_CONFLICT/);
});

test("usage observations reject inconsistent cached tokens", async () => {
  const f = await fixture();
  const active = await running(f);
  await assert.rejects(f.service.recordUsageObservation(f.started.assignment.assignmentId, observation(active.task.taskId, active.execution.executionId, { inputTokens: 1, cachedInputTokens: 2 }), f.context), /cached input tokens/);
});

test("usage provider and model must match the execution-specific Mission Brief", async () => {
  const f = await fixture();
  const task = await f.service.createTask(f.started.assignment.assignmentId, [], f.context);
  await f.service.transitionTask(f.started.assignment.assignmentId, task.taskId, "ready", f.context);
  const execution = await f.service.beginManagedExecution(f.started.assignment.assignmentId, task.taskId, "implementation", { objective: "Measure", scope: [], exclusions: [], acceptance_criteria: [{ id: "AC-1", text: "measured" }], permissions: [], constraints: [], expected_outputs: ["result"], requested_model: { provider: "codex", model: "model-a" } }, f.context);
  await assert.rejects(f.service.recordUsageObservation(f.started.assignment.assignmentId, observation(task.taskId, execution.executionId, { provider: "claude", model: "model-b" }), f.context), /USAGE_MODEL_MISMATCH/);
  const accepted = await f.service.recordUsageObservation(f.started.assignment.assignmentId, observation(task.taskId, execution.executionId, { provider: "codex", model: "model-a" }), f.context);
  assert.equal(accepted.provider, "codex");
});

test("Mission maxRuns and elapsed limits block deterministic future dispatch", async () => {
  const f = await fixture({ maxRuns: 1 });
  await running(f);
  const next = await f.service.createTask(f.started.assignment.assignmentId, [], f.context);
  await f.service.transitionTask(f.started.assignment.assignmentId, next.taskId, "ready", f.context);
  await assert.rejects(f.service.beginExecution(f.started.assignment.assignmentId, next.taskId, f.context), /BUDGET_EXHAUSTED.*maxRuns/);

  let clock = new Date("2026-09-15T12:00:00.000Z");
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter);
  const started = await service.start({ objective: "Timed", approach: ["wait"], acceptanceCriteria: ["bounded"], waiveApproval: true, budget: { elapsedMs: 1_000 } }, { ...manager, actor: executive, now: () => clock });
  const context = { ...manager, ownershipToken: started.assignment.ownershipLease!.token, now: () => clock };
  const task = await service.createTask(started.assignment.assignmentId, [], context);
  await service.transitionTask(started.assignment.assignmentId, task.taskId, "ready", context);
  clock = new Date("2026-09-15T12:00:01.000Z");
  await assert.rejects(service.beginExecution(started.assignment.assignmentId, task.taskId, context), /BUDGET_EXHAUSTED.*elapsedMs/);
});

test("Run budgets reject Mission-only maxRuns and all limits require nonnegative safe integers", async () => {
  const f = await fixture();
  await assert.rejects(f.service.createTask(f.started.assignment.assignmentId, [], f.context, { runBudget: { maxRuns: 1 } }), /RUN_BUDGET_INVALID/);
  await assert.rejects(f.service.createTask(f.started.assignment.assignmentId, [], f.context, { runBudget: { totalTokens: -1 } }), /RUN_BUDGET_INVALID/);
});
