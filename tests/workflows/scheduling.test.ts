import assert from "node:assert/strict";
import test from "node:test";
import defaults from "../../defaults/config.json" with { type: "json" };
import type { FrameworkConfiguration } from "../../src/contracts/configuration.ts";
import { MemoryWorkflowRepository, WorkflowCommandService, type AssignmentAggregate, type TaskState } from "../../src/commands/index.ts";
import { schedulingDecision, taskCancellationImpact, validateTaskGraph } from "../../src/scheduling/index.ts";

const manager = { actor: { actorId: "manager-1", actorType: "manager" as const }, managerInstanceId: "mgr-1" };
const executive = { actorId: "executive-1", actorType: "executive" as const };
const adapter = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-1", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
const owned = (started: { assignment: { ownershipLease?: { token: string } } }) => ({ ...manager, ownershipToken: started.assignment.ownershipLease!.token });
const task = (taskId: string, createdSequence: number, priority = 0): TaskState => ({ taskId, state: "ready", affectedPaths: [], executionIds: [], resultIds: [], dependencies: [], priority, createdSequence });

async function startedService() {
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter);
  const started = await service.start({ objective: "Schedule work", approach: ["dispatch"], acceptanceCriteria: ["ordered"], waiveApproval: true }, { ...manager, actor: executive });
  return { repository, service, started, context: owned(started) };
}

test("scheduler selects eligible Operations deterministically by priority then creation sequence", async () => {
  const { started } = await startedService();
  const assignment = structuredClone(started.assignment) as AssignmentAggregate;
  assignment.tasks = [task("tsk-first", 1, 1), task("tsk-high-late", 3, 5), task("tsk-high-early", 2, 5)];
  assert.deepEqual(schedulingDecision(assignment, { maxConcurrentOperations: 2 }).eligible.map((item) => item.taskId), ["tsk-high-early", "tsk-high-late"]);
});

test("required dependencies block dispatch until an accepted outcome while optional dependencies do not", async () => {
  const { service, started, context } = await startedService();
  const root = await service.createTask(started.assignment.assignmentId, [], context);
  const required = await service.createTask(started.assignment.assignmentId, [], context, { dependencies: [{ taskId: root.taskId }] });
  const optional = await service.createTask(started.assignment.assignmentId, [], context, { dependencies: [{ taskId: root.taskId, required: false }] });
  for (const item of [root, required, optional]) await service.transitionTask(started.assignment.assignmentId, item.taskId, "ready", context);
  await assert.rejects(service.transitionTask(started.assignment.assignmentId, required.taskId, "dispatched", context), /DEPENDENCY_UNSATISFIED/);
  assert.equal((await service.transitionTask(started.assignment.assignmentId, optional.taskId, "dispatched", context)).state, "dispatched");
  const execution = await service.beginExecution(started.assignment.assignmentId, root.taskId, context);
  await service.recordExecutionOutcome(started.assignment.assignmentId, execution.executionId, "completed", context);
  await service.submitResult(started.assignment.assignmentId, root.taskId, "res-root", context);
  await service.acceptResult(started.assignment.assignmentId, root.taskId, context);
  assert.equal((await service.transitionTask(started.assignment.assignmentId, required.taskId, "dispatched", context)).state, "dispatched");
});

test("automatic dispatch through beginExecution cannot bypass dependency eligibility", async () => {
  const { service, started, context } = await startedService();
  const root = await service.createTask(started.assignment.assignmentId, [], context);
  const dependent = await service.createTask(started.assignment.assignmentId, [], context, { dependencies: [{ taskId: root.taskId }] });
  await service.transitionTask(started.assignment.assignmentId, dependent.taskId, "ready", context);
  await assert.rejects(service.beginExecution(started.assignment.assignmentId, dependent.taskId, context), /DEPENDENCY_UNSATISFIED/);
});

test("required quality gates enforce pre-dispatch and pre-acceptance phases", async () => {
  const { service, started, context } = await startedService();
  const operation = await service.createTask(started.assignment.assignmentId, [], context, { gates: [
    { gateId: "security-review", name: "Security review", phase: "pre_dispatch" },
    { gateId: "qa", name: "QA", phase: "pre_acceptance" },
    { gateId: "ux-advisory", name: "UX advisory", phase: "pre_acceptance", required: false },
  ] });
  await service.transitionTask(started.assignment.assignmentId, operation.taskId, "ready", context);
  await assert.rejects(service.beginExecution(started.assignment.assignmentId, operation.taskId, context), /GATE_PENDING/);
  await service.recordTaskGateOutcome(started.assignment.assignmentId, operation.taskId, "security-review", "passed", [], context);
  const execution = await service.beginExecution(started.assignment.assignmentId, operation.taskId, context);
  await service.recordExecutionOutcome(started.assignment.assignmentId, execution.executionId, "completed", context);
  await service.submitResult(started.assignment.assignmentId, operation.taskId, "res-gated", context);
  await assert.rejects(service.acceptResult(started.assignment.assignmentId, operation.taskId, context), /GATE_PENDING/);
  await service.recordTaskGateOutcome(started.assignment.assignmentId, operation.taskId, "qa", "failed", [], context);
  await assert.rejects(service.acceptResult(started.assignment.assignmentId, operation.taskId, context), /GATE_FAILED/);
  await service.recordTaskGateOutcome(started.assignment.assignmentId, operation.taskId, "qa", "passed", [], context);
  assert.equal((await service.acceptResult(started.assignment.assignmentId, operation.taskId, context)).state, "accepted");
});

test("gate waivers require Executive authority and gate evidence must exist", async () => {
  const { service, started, context } = await startedService();
  const operation = await service.createTask(started.assignment.assignmentId, [], context, { gates: [{ gateId: "qa", name: "QA", phase: "pre_dispatch" }] });
  await assert.rejects(service.recordTaskGateOutcome(started.assignment.assignmentId, operation.taskId, "qa", "waived", [], context), /WAIVER_REQUIRES_EXECUTIVE/);
  await assert.rejects(service.recordTaskGateOutcome(started.assignment.assignmentId, operation.taskId, "qa", "passed", ["evd-missing"], context), /EVIDENCE_MISSING/);
  const executiveContext = { ...context, actor: executive };
  assert.equal((await service.recordTaskGateOutcome(started.assignment.assignmentId, operation.taskId, "qa", "waived", [], executiveContext)).gates?.[0]?.status, "waived");
});

test("scheduler reports terminal dependency failure and concurrency exhaustion", async () => {
  const { started } = await startedService();
  const assignment = structuredClone(started.assignment) as AssignmentAggregate;
  const cancelled = { ...task("tsk-cancelled", 1), state: "cancelled" as const };
  const dependent = { ...task("tsk-dependent", 2), dependencies: [{ taskId: cancelled.taskId, required: true, acceptableStates: ["accepted" as const, "closed" as const] }] };
  const running = { ...task("tsk-running", 3), state: "running" as const };
  const waiting = task("tsk-waiting", 4);
  assignment.tasks = [cancelled, dependent, running, waiting];
  const decision = schedulingDecision(assignment, { maxConcurrentOperations: 1 });
  assert.equal(decision.blocked.find((item) => item.task.taskId === dependent.taskId)?.reasons[0]?.code, "DEPENDENCY_TERMINAL_FAILURE");
  assert.equal(decision.blocked.find((item) => item.task.taskId === waiting.taskId)?.reasons[0]?.code, "CONCURRENCY_LIMIT_REACHED");
});

test("configured Operation concurrency is enforced by both dispatch entry points", async () => {
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter, { maxConcurrentOperations: 1 });
  const started = await service.start({ objective: "Bound concurrency", approach: ["limit"], acceptanceCriteria: ["one at a time"], waiveApproval: true }, { ...manager, actor: executive });
  const context = owned(started);
  const first = await service.createTask(started.assignment.assignmentId, [], context);
  const second = await service.createTask(started.assignment.assignmentId, [], context);
  await service.transitionTask(started.assignment.assignmentId, first.taskId, "ready", context);
  await service.transitionTask(started.assignment.assignmentId, second.taskId, "ready", context);
  await service.beginExecution(started.assignment.assignmentId, first.taskId, context);
  await assert.rejects(service.transitionTask(started.assignment.assignmentId, second.taskId, "dispatched", context), /CONCURRENCY_LIMIT_REACHED/);
  await assert.rejects(service.beginExecution(started.assignment.assignmentId, second.taskId, context), /CONCURRENCY_LIMIT_REACHED/);
});

test("task graph validation rejects missing required dependencies, duplicates, self references, and cycles", () => {
  assert.throws(() => validateTaskGraph([{ ...task("tsk-a", 1), dependencies: [{ taskId: "tsk-missing", required: true, acceptableStates: ["closed"] }] }]), /TASK_DEPENDENCY_MISSING/);
  assert.throws(() => validateTaskGraph([{ ...task("tsk-a", 1), dependencies: [{ taskId: "tsk-b", required: false, acceptableStates: ["closed"] }, { taskId: "tsk-b", required: false, acceptableStates: ["closed"] }] }]), /duplicate dependency/);
  assert.throws(() => validateTaskGraph([{ ...task("tsk-a", 1), dependencies: [{ taskId: "tsk-a", required: true, acceptableStates: ["closed"] }] }]), /cannot depend on itself/);
  assert.throws(() => validateTaskGraph([
    { ...task("tsk-a", 1), dependencies: [{ taskId: "tsk-b", required: true, acceptableStates: ["closed"] }] },
    { ...task("tsk-b", 2), dependencies: [{ taskId: "tsk-a", required: true, acceptableStates: ["closed"] }] },
  ]), /TASK_DEPENDENCY_CYCLE/);
});

test("cancellation propagates transitively through required but not optional dependencies", async () => {
  const { service, started, context } = await startedService();
  const root = await service.createTask(started.assignment.assignmentId, [], context);
  const child = await service.createTask(started.assignment.assignmentId, [], context, { dependencies: [{ taskId: root.taskId }] });
  const grandchild = await service.createTask(started.assignment.assignmentId, [], context, { dependencies: [{ taskId: child.taskId }] });
  const optional = await service.createTask(started.assignment.assignmentId, [], context, { dependencies: [{ taskId: root.taskId, required: false }] });
  for (const item of [root, child, grandchild, optional]) await service.transitionTask(started.assignment.assignmentId, item.taskId, "ready", context);
  const impact = taskCancellationImpact((await service.status(started.assignment.assignmentId, context)).assignment, root.taskId);
  assert.deepEqual(impact.affectedTasks.map((item) => item.taskId), [root.taskId, child.taskId, grandchild.taskId]);
  await service.cancelTask(started.assignment.assignmentId, root.taskId, {}, context);
  const current = (await service.status(started.assignment.assignmentId, context)).assignment;
  assert.deepEqual(current.tasks.map((item) => item.state), ["cancelled", "cancelled", "cancelled", "ready"]);
});

test("cancelling a running Operation confirms provider stop before terminalizing dependents", async () => {
  const { service, started, context } = await startedService();
  const root = await service.createTask(started.assignment.assignmentId, [], context);
  const child = await service.createTask(started.assignment.assignmentId, [], context, { dependencies: [{ taskId: root.taskId }] });
  await service.transitionTask(started.assignment.assignmentId, root.taskId, "ready", context);
  await service.transitionTask(started.assignment.assignmentId, child.taskId, "ready", context);
  const execution = await service.beginExecution(started.assignment.assignmentId, root.taskId, context);
  await service.cancelTask(started.assignment.assignmentId, root.taskId, { mode: "graceful" }, context);
  const current = (await service.status(started.assignment.assignmentId, context)).assignment;
  assert.equal(current.executions.find((item) => item.executionId === execution.executionId)?.state, "cancelled");
  assert.equal(current.tasks.find((item) => item.taskId === root.taskId)?.state, "cancelled");
  assert.equal(current.tasks.find((item) => item.taskId === child.taskId)?.state, "cancelled");
});

test("unconfirmed cancellation becomes explicit unknown state and blocks the Mission", async () => {
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, { ...adapter, async requestStop() { return { confirmed: false }; } });
  const started = await service.start({ objective: "Cancel safely", approach: ["stop"], acceptanceCriteria: ["known"], waiveApproval: true }, { ...manager, actor: executive });
  const context = owned(started);
  const root = await service.createTask(started.assignment.assignmentId, [], context);
  await service.transitionTask(started.assignment.assignmentId, root.taskId, "ready", context);
  await service.beginExecution(started.assignment.assignmentId, root.taskId, context);
  const cancelled = await service.cancelTask(started.assignment.assignmentId, root.taskId, { mode: "force" }, context);
  assert.equal(cancelled.state, "blocked");
  const current = (await service.status(started.assignment.assignmentId, context)).assignment;
  assert.equal(current.lifecycle, "blocked");
  assert.equal(current.executions[0]?.state, "unknown");
});
