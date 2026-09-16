import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import defaults from "../../defaults/config.json" with { type: "json" };
import type { FrameworkConfiguration } from "../../src/contracts/configuration.ts";
import { StateWorkflowRepository, WorkflowCommandService } from "../../src/commands/index.ts";
import { coreSchemaRegistry } from "../../src/registries/index.ts";
import { resolveRecord } from "../../src/storage/index.ts";

test("restart reconstructs accepted state from validated canonical records without the ledger", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-canonical-"));
  const repository = new StateWorkflowRepository({ projectRoot: root, policySnapshot: { configuration_digest: "sha256:test" } });
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, {
    async requestStop() { return { confirmed: true }; },
    async createTransferPackage() { return { packageId: "pkg-test", valid: true }; },
    async transferOwnership() { return { accepted: true }; },
  });
  const context = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1" };
  const started = await service.start({ objective: "Canonical restart", approach: ["implement"], acceptanceCriteria: ["state survives"], waiveApproval: true }, context);
  const owned = { ...context, ownershipToken: started.assignment.ownershipLease!.token };
  const task = await service.createTask(started.assignment.assignmentId, ["implementation.details"], owned);
  await service.transitionTask(started.assignment.assignmentId, task.taskId, "ready", owned);
  const execution = await service.beginExecution(started.assignment.assignmentId, task.taskId, owned);
  await service.recordExecutionOutcome(started.assignment.assignmentId, execution.executionId, "completed", owned);
  await service.submitResult(started.assignment.assignmentId, task.taskId, "result-1", owned, { executionId: execution.executionId, deliveryStatus: "complete", summary: "Verified result" });
  const assignmentRecord = (await resolveRecord(path.join(root, ".agent-state"), started.assignment.assignmentId)).record;
  assert.equal(coreSchemaRegistry.validateRecord("assignment", assignmentRecord).valid, true);
  await rm(path.join(root, ".agent-state", "ledger"), { recursive: true, force: true });
  const restarted = new StateWorkflowRepository({ projectRoot: root });
  const restored = await restarted.get(started.assignment.assignmentId);
  assert.equal(restored?.objective, "Canonical restart");
  assert.equal(restored?.tasks[0]?.state, "result_submitted");
  assert.equal(restored?.executions[0]?.state, "completed");
  assert.equal(restored?.results[0]?.summary, "Verified result");
});

test("restart preserves deterministic task scheduling metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-scheduling-restart-"));
  const repository = new StateWorkflowRepository({ projectRoot: root });
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, {
    async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-test", valid: true }; }, async transferOwnership() { return { accepted: true }; },
  });
  const base = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1" };
  const started = await service.start({ objective: "Persist scheduling", approach: ["record"], acceptanceCriteria: ["restored"], waiveApproval: true }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const first = await service.createTask(started.assignment.assignmentId, ["src/a.ts"], context, { priority: 2 });
  const second = await service.createTask(started.assignment.assignmentId, ["src/b.ts"], context, { priority: 7, dependencies: [{ taskId: first.taskId, acceptableStates: ["closed"] }], gates: [{ gateId: "qa", name: "QA", phase: "pre_acceptance" }] });
  const restored = await new StateWorkflowRepository({ projectRoot: root }).get(started.assignment.assignmentId);
  assert.deepEqual(restored?.tasks.find((item) => item.taskId === second.taskId)?.dependencies, [{ taskId: first.taskId, required: true, acceptableStates: ["closed"] }]);
  assert.equal(restored?.tasks.find((item) => item.taskId === second.taskId)?.priority, 7);
  assert.equal(restored?.tasks.find((item) => item.taskId === second.taskId)?.createdSequence, 2);
  assert.deepEqual(restored?.tasks.find((item) => item.taskId === second.taskId)?.gates, [{ gateId: "qa", name: "QA", phase: "pre_acceptance", required: true, status: "pending", evidenceIds: [] }]);
});

test("restart preserves Mission and Run budgets with immutable usage observations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-budget-restart-"));
  const repository = new StateWorkflowRepository({ projectRoot: root });
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, {
    async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-test", valid: true }; }, async transferOwnership() { return { accepted: true }; },
  });
  const base = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1", now: () => new Date("2026-09-15T12:00:00.000Z") };
  const started = await service.start({ objective: "Persist budgets", approach: ["measure"], acceptanceCriteria: ["restored"], waiveApproval: true, budget: { totalTokens: 100, costMicros: 1_000 } }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const task = await service.createTask(started.assignment.assignmentId, ["src/a.ts"], context, { runBudget: { outputTokens: 50 } });
  await service.transitionTask(started.assignment.assignmentId, task.taskId, "ready", context);
  const execution = await service.beginExecution(started.assignment.assignmentId, task.taskId, context);
  await service.recordUsageObservation(started.assignment.assignmentId, { observationId: "uobs-restart", taskId: task.taskId, executionId: execution.executionId, provider: "test-provider", model: "test-model", measurement: "observed", inputTokens: 20, outputTokens: 30, cachedInputTokens: 5, costMicros: 400, observedAt: "2026-09-15T12:00:01.000Z" }, context);
  await rm(path.join(root, ".agent-state", "ledger"), { recursive: true, force: true });
  const restored = await new StateWorkflowRepository({ projectRoot: root }).get(started.assignment.assignmentId);
  assert.deepEqual(restored?.budget, { totalTokens: 100, costMicros: 1_000 });
  assert.deepEqual(restored?.tasks[0]?.runBudget, { outputTokens: 50 });
  assert.deepEqual(restored?.usage, { inputTokens: 20, outputTokens: 30, cachedInputTokens: 5, costMicros: 400 });
  assert.deepEqual(restored?.executions[0]?.usage, restored?.usage);
  assert.equal(restored?.usageObservations?.[0]?.observationId, "uobs-restart");
});

test("restart preserves a scheduled retry and its deterministic backoff", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-retry-restart-"));
  let clock = new Date("2026-09-15T12:00:00.000Z");
  const repository = new StateWorkflowRepository({ projectRoot: root });
  const operations = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-test", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, operations);
  const base = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1", now: () => clock };
  const started = await service.start({ objective: "Persist retry", approach: ["retry"], acceptanceCriteria: ["restored"], waiveApproval: true }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const task = await service.createTask(started.assignment.assignmentId, [], context, { retryPolicy: { maxAttempts: 2, backoffSeconds: [30] } });
  await service.transitionTask(started.assignment.assignmentId, task.taskId, "ready", context);
  const first = await service.beginExecution(started.assignment.assignmentId, task.taskId, context);
  await service.recordExecutionOutcome(started.assignment.assignmentId, first.executionId, "failed", context);
  await service.scheduleExecutionRetry(started.assignment.assignmentId, task.taskId, first.executionId, context);
  await rm(path.join(root, ".agent-state", "ledger"), { recursive: true, force: true });

  const restartedRepository = new StateWorkflowRepository({ projectRoot: root });
  const restartedService = new WorkflowCommandService(restartedRepository, defaults as FrameworkConfiguration, operations);
  const restored = await restartedRepository.get(started.assignment.assignmentId);
  assert.deepEqual(restored?.tasks[0]?.retryPolicy, { maxAttempts: 2, backoffSeconds: [30] });
  assert.equal(restored?.tasks[0]?.retryState?.nextAttemptAt, "2026-09-15T12:00:30.000Z");
  assert.equal(restored?.executions[0]?.endedAt, "2026-09-15T12:00:00.000Z");
  await assert.rejects(restartedService.beginExecution(started.assignment.assignmentId, task.taskId, context), /RETRY_BACKOFF_ACTIVE/);
  clock = new Date("2026-09-15T12:00:30.000Z");
  const retry = await restartedService.beginExecution(started.assignment.assignmentId, task.taskId, context);
  assert.equal(retry.runKind, "retry");
  assert.equal(retry.retryAttempt, 2);
});

test("restart preserves conditional route definitions and resolutions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-route-restart-"));
  const repository = new StateWorkflowRepository({ projectRoot: root });
  const operations = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-test", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, operations);
  const base = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1", now: () => new Date("2026-09-15T12:00:00.000Z") };
  const started = await service.start({ objective: "Persist routes", approach: ["branch"], acceptanceCriteria: ["restored"], waiveApproval: true }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const source = await service.createTask(started.assignment.assignmentId, ["source"], context);
  const target = await service.createTask(started.assignment.assignmentId, ["target"], context);
  const route = await service.createConditionalRoute(started.assignment.assignmentId, { sourceTaskId: source.taskId, sourceKind: "task", expectedValue: "cancelled", targetTaskId: target.taskId, effect: "skip" }, context);
  await service.cancelTask(started.assignment.assignmentId, source.taskId, {}, context);
  await service.evaluateConditionalRoute(started.assignment.assignmentId, route.routeId, context);
  await rm(path.join(root, ".agent-state", "ledger"), { recursive: true, force: true });
  const restored = await new StateWorkflowRepository({ projectRoot: root }).get(started.assignment.assignmentId);
  assert.equal(restored?.routes?.[0]?.routeId, route.routeId);
  assert.equal(restored?.routes?.[0]?.state, "applied");
  assert.equal(restored?.routes?.[0]?.observedValue, "cancelled");
  assert.equal(restored?.tasks.find((item) => item.taskId === target.taskId)?.state, "skipped");
  const record = (await resolveRecord(path.join(root, ".agent-state"), route.routeId)).record;
  assert.equal(coreSchemaRegistry.validateRecord("route", record).valid, true);
});

test("restart preserves immutable workflow-template application provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-template-restart-"));
  const repository = new StateWorkflowRepository({ projectRoot: root });
  const operations = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-test", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, operations);
  const base = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1", now: () => new Date("2026-09-15T14:00:00.000Z") };
  const started = await service.start({ objective: "Persist template", approach: ["expand"], acceptanceCriteria: ["restored"], waiveApproval: true }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const template = { schemaVersion: "1.0" as const, templateId: "tpl-restart", version: "1.0.0", name: "Restart", operations: [{ key: "build", role: "implementation", affectedPaths: ["src/**"] }], routes: [] };
  const applied = await service.applyWorkflowTemplate(started.assignment.assignmentId, { applicationId: "tapp-restart", template }, context);
  await rm(path.join(root, ".agent-state", "ledger"), { recursive: true, force: true });
  const restored = await new StateWorkflowRepository({ projectRoot: root }).get(started.assignment.assignmentId);
  assert.equal(restored?.templateApplications?.[0]?.templateDigest, applied.templateDigest);
  assert.equal(restored?.templateApplications?.[0]?.operationBindings.build, restored?.tasks[0]?.taskId);
  const record = (await resolveRecord(path.join(root, ".agent-state"), "tapp-restart")).record;
  assert.equal(coreSchemaRegistry.validateRecord("template-application", record).valid, true);
  const eventNames = await readdir(path.join(root, ".agent-state", "events"));
  const events = (await Promise.all(eventNames.filter((name) => name.endsWith(".jsonl")).map(async (name) => (await readFile(path.join(root, ".agent-state", "events", name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)))).flat();
  const taskEvent = events.find((event) => event.event_type === "task.created" && (event.data as { details?: { templateApplicationId?: string } }).details?.templateApplicationId === "tapp-restart");
  const templateEvent = events.find((event) => event.event_type === "template.applied");
  assert.equal(((taskEvent?.data as { record_ref?: { record_type?: string } }).record_ref?.record_type), "task");
  assert.equal(((templateEvent?.data as { record_ref?: { record_type?: string } }).record_ref?.record_type), "template-application");
});

test("unknown action persistence creates pending and concrete reconciliation removes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-pending-integration-"));
  const repository = new StateWorkflowRepository({ projectRoot: root });
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, {
    async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-test", valid: true }; }, async transferOwnership() { return { accepted: true }; },
  });
  const context = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1" };
  const started = await service.start({ objective: "Pending", approach: ["act"], acceptanceCriteria: ["reconciled"], waiveApproval: true }, context);
  const owned = { ...context, ownershipToken: started.assignment.ownershipLease!.token };
  const action = await service.createAction(started.assignment.assignmentId, "external effect", owned);
  await service.recordActionOutcome(started.assignment.assignmentId, action.actionId, "started", owned);
  await service.recordActionOutcome(started.assignment.assignmentId, action.actionId, "unknown", owned);
  const pending = path.join(root, ".agent-state", "pending", `${action.actionId}.json`);
  await access(pending);
  await service.reconcileAction(started.assignment.assignmentId, action.actionId, "failed", owned);
  await assert.rejects(access(pending));
});
