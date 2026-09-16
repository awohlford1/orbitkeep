import assert from "node:assert/strict";
import test from "node:test";
import defaults from "../../defaults/config.json" with { type: "json" };
import type { FrameworkConfiguration } from "../../src/contracts/configuration.ts";
import { MemoryWorkflowRepository, WorkflowCommandService } from "../../src/commands/index.ts";

const adapter = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-1", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
const executive = { actorId: "executive-1", actorType: "executive" as const };

async function fixture() {
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter);
  const base = { actor: executive, managerInstanceId: "mgr-1" };
  const started = await service.start({ objective: "Route deterministically", approach: ["branch"], acceptanceCriteria: ["auditable"], waiveApproval: true }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const source = await service.createTask(started.assignment.assignmentId, ["source"], context);
  const target = await service.createTask(started.assignment.assignmentId, ["target"], context);
  return { repository, service, started, context, source, target };
}

test("a concrete completed Run activates a draft branch exactly once", async () => {
  const f = await fixture();
  const route = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "execution", expectedValue: "completed", targetTaskId: f.target.taskId, effect: "activate" }, f.context);
  await assert.rejects(f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context), /ROUTE_SOURCE_NOT_READY/);
  await f.service.transitionTask(f.started.assignment.assignmentId, f.source.taskId, "ready", f.context);
  const execution = await f.service.beginExecution(f.started.assignment.assignmentId, f.source.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, execution.executionId, "completed", f.context);
  const applied = await f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context);
  assert.equal(applied.state, "applied");
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.tasks.find((item) => item.taskId === f.target.taskId)?.state, "ready");
  assert.deepEqual(await f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context), applied);
  assert.equal(f.repository.events.filter((event) => event.type === "route.applied").length, 1);
});

test("unknown Runs never satisfy a route", async () => {
  const f = await fixture();
  const route = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "execution", expectedValue: "completed", targetTaskId: f.target.taskId, effect: "activate" }, f.context);
  await f.service.transitionTask(f.started.assignment.assignmentId, f.source.taskId, "ready", f.context);
  const execution = await f.service.beginExecution(f.started.assignment.assignmentId, f.source.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, execution.executionId, "unknown", f.context);
  await assert.rejects(f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context), /ROUTE_SOURCE_NOT_READY/);
});

test("a concrete mismatch is audited but leaves the route pending", async () => {
  const f = await fixture();
  const route = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "execution", expectedValue: "failed", targetTaskId: f.target.taskId, effect: "block" }, f.context);
  await f.service.transitionTask(f.started.assignment.assignmentId, f.source.taskId, "ready", f.context);
  const execution = await f.service.beginExecution(f.started.assignment.assignmentId, f.source.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, execution.executionId, "completed", f.context);
  const evaluated = await f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context);
  assert.equal(evaluated.state, "pending");
  assert.equal(evaluated.observedValue, "completed");
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.tasks.find((item) => item.taskId === f.target.taskId)?.state, "draft");
  assert.equal(f.repository.events.at(-1)?.type, "route.evaluated");
});

test("gate and Operation outcomes can skip and block branches", async () => {
  const f = await fixture();
  const gated = await f.service.createTask(f.started.assignment.assignmentId, ["gated"], f.context, { gates: [{ gateId: "qa", name: "QA", phase: "pre_acceptance" }] });
  const skipped = await f.service.createTask(f.started.assignment.assignmentId, ["skipped"], f.context);
  const gateRoute = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: gated.taskId, sourceKind: "gate", gateId: "qa", expectedValue: "failed", targetTaskId: skipped.taskId, effect: "skip" }, f.context);
  await f.service.recordTaskGateOutcome(f.started.assignment.assignmentId, gated.taskId, "qa", "failed", [], f.context);
  await f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, gateRoute.routeId, f.context);
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.tasks.find((item) => item.taskId === skipped.taskId)?.state, "skipped");
  await assert.rejects(f.service.transitionTask(f.started.assignment.assignmentId, f.target.taskId, "skipped", f.context), /ROUTE_COMMAND_REQUIRED/);

  await f.service.transitionTask(f.started.assignment.assignmentId, f.source.taskId, "ready", f.context);
  await f.service.cancelTask(f.started.assignment.assignmentId, f.source.taskId, {}, f.context);
  const taskRoute = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "task", expectedValue: "cancelled", targetTaskId: f.target.taskId, effect: "block" }, f.context);
  await f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, taskRoute.routeId, f.context);
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.tasks.find((item) => item.taskId === f.target.taskId)?.state, "blocked");
});

test("route cancellation propagates through required dependencies", async () => {
  const f = await fixture();
  const child = await f.service.createTask(f.started.assignment.assignmentId, ["child"], f.context, { dependencies: [{ taskId: f.target.taskId }] });
  await f.service.transitionTask(f.started.assignment.assignmentId, f.source.taskId, "ready", f.context);
  await f.service.cancelTask(f.started.assignment.assignmentId, f.source.taskId, {}, f.context);
  const route = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "task", expectedValue: "cancelled", targetTaskId: f.target.taskId, effect: "cancel" }, f.context);
  await f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context);
  const current = await f.repository.get(f.started.assignment.assignmentId);
  assert.equal(current?.tasks.find((item) => item.taskId === f.target.taskId)?.state, "cancelled");
  assert.equal(current?.tasks.find((item) => item.taskId === child.taskId)?.state, "cancelled");
});

test("route cancellation cannot bypass observable provider stop", async () => {
  const f = await fixture();
  await f.service.transitionTask(f.started.assignment.assignmentId, f.source.taskId, "ready", f.context);
  await f.service.cancelTask(f.started.assignment.assignmentId, f.source.taskId, {}, f.context);
  await f.service.transitionTask(f.started.assignment.assignmentId, f.target.taskId, "ready", f.context);
  await f.service.beginExecution(f.started.assignment.assignmentId, f.target.taskId, f.context);
  const route = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "task", expectedValue: "cancelled", targetTaskId: f.target.taskId, effect: "cancel" }, f.context);
  await assert.rejects(f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context), /REQUIRES_EXPLICIT_CANCELLATION/);
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.routes?.[0]?.state, "pending");
});

test("route definitions reject invalid references and values", async () => {
  const f = await fixture();
  await assert.rejects(f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "execution", expectedValue: "unknown", targetTaskId: f.target.taskId, effect: "activate" }, f.context), /EXPECTED_VALUE_INVALID/);
  await assert.rejects(f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "gate", expectedValue: "passed", targetTaskId: f.target.taskId, effect: "activate" }, f.context), /ROUTE_GATE_REQUIRED/);
  await assert.rejects(f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "task", gateId: "qa", expectedValue: "closed", targetTaskId: f.target.taskId, effect: "activate" }, f.context), /ROUTE_GATE_INVALID/);
  await assert.rejects(f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "task", expectedValue: "closed", targetTaskId: f.source.taskId, effect: "activate" }, f.context), /ROUTE_SELF_REFERENCE/);
});

test("a skipped Operation is a valid terminal Mission branch", async () => {
  const f = await fixture();
  await f.service.transitionTask(f.started.assignment.assignmentId, f.source.taskId, "ready", f.context);
  const execution = await f.service.beginExecution(f.started.assignment.assignmentId, f.source.taskId, f.context);
  await f.service.recordExecutionOutcome(f.started.assignment.assignmentId, execution.executionId, "completed", f.context);
  await f.service.submitResult(f.started.assignment.assignmentId, f.source.taskId, "res-1", f.context);
  await f.service.acceptResult(f.started.assignment.assignmentId, f.source.taskId, f.context);
  await f.service.closeTask(f.started.assignment.assignmentId, f.source.taskId, f.context);
  const route = await f.service.createConditionalRoute(f.started.assignment.assignmentId, { sourceTaskId: f.source.taskId, sourceKind: "task", expectedValue: "closed", targetTaskId: f.target.taskId, effect: "skip" }, f.context);
  await f.service.evaluateConditionalRoute(f.started.assignment.assignmentId, route.routeId, f.context);
  assert.equal((await f.service.closeAssignment(f.started.assignment.assignmentId, f.context)).status, "succeeded");
});
