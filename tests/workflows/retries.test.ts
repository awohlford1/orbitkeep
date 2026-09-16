import assert from "node:assert/strict";
import test from "node:test";
import defaults from "../../defaults/config.json" with { type: "json" };
import type { FrameworkConfiguration } from "../../src/contracts/configuration.ts";
import { MemoryWorkflowRepository, WorkflowCommandService, type RetryPolicy } from "../../src/commands/index.ts";

const adapter = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-1", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
const executive = { actorId: "executive-1", actorType: "executive" as const };

async function fixture(policy?: RetryPolicy) {
  let clock = new Date("2026-09-15T12:00:00.000Z");
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter);
  const base = { actor: executive, managerInstanceId: "mgr-1", now: () => clock };
  const started = await service.start({ objective: "Retry safely", approach: ["attempt"], acceptanceCriteria: ["bounded"], waiveApproval: true }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const task = await service.createTask(started.assignment.assignmentId, [], context, policy ? { retryPolicy: policy } : {});
  await service.transitionTask(started.assignment.assignmentId, task.taskId, "ready", context);
  return { repository, service, started, context, task, setClock(value: string) { clock = new Date(value); } };
}

test("retries are disabled by default and a failed Run becomes explicitly exhausted", async () => {
  const f = await fixture();
  const execution = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, execution.executionId, "failed", f.context);
  const current = await f.repository.get(f.started.assignment.assignmentId);
  assert.equal(current?.tasks[0]?.state, "blocked");
  assert.equal(current?.tasks[0]?.retryState?.status, "exhausted");
  await assert.rejects(f.service.scheduleExecutionRetry(f.started.assignment.assignmentId, f.task.taskId, execution.executionId, f.context), /RETRY_EXHAUSTED/);
});

test("an explicit retry is idempotently scheduled and backoff blocks early dispatch", async () => {
  const f = await fixture({ maxAttempts: 3, backoffSeconds: [10, 20] });
  const first = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, first.executionId, "failed", f.context);
  const scheduled = await f.service.scheduleExecutionRetry(f.started.assignment.assignmentId, f.task.taskId, first.executionId, f.context);
  assert.equal(scheduled.retryState?.nextAttemptAt, "2026-09-15T12:00:10.000Z");
  assert.deepEqual(await f.service.scheduleExecutionRetry(f.started.assignment.assignmentId, f.task.taskId, first.executionId, f.context), scheduled);
  await assert.rejects(f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context), /RETRY_BACKOFF_ACTIVE/);
  f.setClock("2026-09-15T12:00:10.000Z");
  const second = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  assert.notEqual(second.executionId, first.executionId);
  assert.equal(second.attempt, 2);
  assert.equal(second.runKind, "retry");
  assert.equal(second.retryAttempt, 2);
});

test("retry limits are enforced across consecutive failures", async () => {
  const f = await fixture({ maxAttempts: 2, backoffSeconds: [0] });
  const first = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, first.executionId, "failed", f.context);
  await f.service.scheduleExecutionRetry(f.started.assignment.assignmentId, f.task.taskId, first.executionId, f.context);
  const second = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, second.executionId, "failed", f.context);
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.tasks[0]?.retryState?.status, "exhausted");
  await assert.rejects(f.service.scheduleExecutionRetry(f.started.assignment.assignmentId, f.task.taskId, second.executionId, f.context), /RETRY_EXHAUSTED/);
});

test("generic task transitions cannot bypass retry scheduling or exhaustion", async () => {
  const f = await fixture({ maxAttempts: 2, backoffSeconds: [0] });
  const execution = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, execution.executionId, "failed", f.context);
  await assert.rejects(f.service.transitionTask(f.started.assignment.assignmentId, f.task.taskId, "ready", f.context), /RETRY_COMMAND_REQUIRED/);
  await assert.rejects(f.service.transitionTask(f.started.assignment.assignmentId, f.task.taskId, "rework", f.context), /RETRY_COMMAND_REQUIRED/);
});

test("unknown and cancelled Runs cannot be retried as failures", async () => {
  const unknown = await fixture({ maxAttempts: 2, backoffSeconds: [0] });
  const uncertain = await unknown.service.beginExecution(unknown.started.assignment.assignmentId, unknown.task.taskId, unknown.context);
  await unknown.service.recordExecutionOutcome(unknown.started.assignment.assignmentId, uncertain.executionId, "unknown", unknown.context);
  await assert.rejects(unknown.service.scheduleExecutionRetry(unknown.started.assignment.assignmentId, unknown.task.taskId, uncertain.executionId, unknown.context), /only a concretely failed Run/);

  const cancelled = await fixture({ maxAttempts: 2, backoffSeconds: [0] });
  const stopped = await cancelled.service.beginExecution(cancelled.started.assignment.assignmentId, cancelled.task.taskId, cancelled.context);
  await cancelled.service.recordExecutionOutcome(cancelled.started.assignment.assignmentId, stopped.executionId, "cancelled", cancelled.context);
  await assert.rejects(cancelled.service.scheduleExecutionRetry(cancelled.started.assignment.assignmentId, cancelled.task.taskId, stopped.executionId, cancelled.context), /only a concretely failed Run/);
});

test("Mission Report rework starts a new retry cycle rather than consuming one", async () => {
  const f = await fixture({ maxAttempts: 2, backoffSeconds: [0] });
  const initial = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, initial.executionId, "completed", f.context);
  await f.service.submitResult(f.started.assignment.assignmentId, f.task.taskId, "res-one", f.context);
  await f.service.requestRework(f.started.assignment.assignmentId, f.task.taskId, f.context);
  const rework = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  assert.equal(rework.runKind, "rework");
  assert.equal(rework.attempt, 2);
  assert.equal(rework.retryAttempt, 1);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, rework.executionId, "failed", f.context);
  await f.service.scheduleExecutionRetry(f.started.assignment.assignmentId, f.task.taskId, rework.executionId, f.context);
  const retry = await f.service.beginExecution(f.started.assignment.assignmentId, f.task.taskId, f.context);
  assert.equal(retry.runKind, "retry");
  assert.equal(retry.attempt, 3);
  assert.equal(retry.retryAttempt, 2);
});

test("retry policy shape requires exactly one backoff per possible retry", async () => {
  await assert.rejects(fixture({ maxAttempts: 3, backoffSeconds: [1] }), /RETRY_POLICY_INVALID/);
  await assert.rejects(fixture({ maxAttempts: 2, backoffSeconds: [-1] }), /RETRY_POLICY_INVALID/);
});
