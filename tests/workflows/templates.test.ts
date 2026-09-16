import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import defaults from "../../defaults/config.json" with { type: "json" };
import type { FrameworkConfiguration } from "../../src/contracts/configuration.ts";
import { MemoryWorkflowRepository, WorkflowCommandService } from "../../src/commands/index.ts";
import { expandWorkflowTemplate, validateWorkflowTemplate, type WorkflowTemplateDefinition } from "../../src/workflows/index.ts";
import { validateJsonSchema, workflowTemplateSchema } from "../../src/validation/schema/index.ts";

const adapter = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-1", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
const template: WorkflowTemplateDefinition = {
  schemaVersion: "1.0", templateId: "tpl-delivery-review", version: "1.2.0", name: "Delivery and review",
  operations: [
    { key: "implement", role: "implementation", affectedPaths: ["src/**"], retryPolicy: { maxAttempts: 2, backoffSeconds: [5] }, priority: 10 },
    { key: "review", role: "reviewer", affectedPaths: ["src/**"], dependencies: [{ operation: "implement", acceptableStates: ["closed"] }], gates: [{ gateId: "quality", name: "Quality review", phase: "pre_acceptance" }] },
    { key: "remediate", role: "implementation", affectedPaths: ["src/**"] },
  ],
  routes: [{ key: "review-failed", sourceOperation: "review", sourceKind: "gate", gateId: "quality", expectedValue: "failed", targetOperation: "remediate", effect: "activate" }],
};

async function fixture() {
  const repository = new MemoryWorkflowRepository();
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter);
  const base = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-1", now: () => new Date("2026-09-15T14:00:00.000Z") };
  const started = await service.start({ objective: "Apply reusable workflow", approach: ["template"], acceptanceCriteria: ["atomic"], waiveApproval: true }, base);
  return { repository, service, started, context: { ...base, ownershipToken: started.assignment.ownershipLease!.token } };
}

test("template compiler resolves aliases, path bindings, dependencies, and conditional targets", () => {
  let task = 0, route = 0;
  const expanded = expandWorkflowTemplate({ template, bindings: { affectedPaths: { implement: ["packages/api/**"] } }, createdAt: "2026-09-15T14:00:00.000Z", startingSequence: 4, taskId: () => `tsk-${++task}`, routeId: () => `rte-${++route}`, defaultRetryPolicy: { maxAttempts: 1, backoffSeconds: [] } });
  assert.equal(expanded.tasks[0]?.affectedPaths[0], "packages/api/**");
  assert.equal(expanded.tasks[0]?.createdSequence, 4);
  assert.equal(expanded.tasks[0]?.state, "ready");
  assert.equal(expanded.tasks[0]?.role, "implementation");
  assert.equal(expanded.tasks[1]?.dependencies?.[0]?.taskId, expanded.operationBindings.implement);
  assert.equal(expanded.tasks[2]?.state, "draft");
  assert.equal(expanded.routes[0]?.sourceTaskId, expanded.operationBindings.review);
  assert.equal(expanded.routes[0]?.targetTaskId, expanded.operationBindings.remediate);
  assert.match(expanded.templateDigest, /^sha256:[a-f0-9]{64}$/);
});

test("packaged software-delivery template satisfies the public authoring schema", async () => {
  const packaged = JSON.parse(await readFile(new URL("../../templates/software-delivery.json", import.meta.url), "utf8"));
  const result = validateJsonSchema("workflow-template", "1.0", workflowTemplateSchema, packaged);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(validateWorkflowTemplate(packaged).templateId, "tpl-software-delivery");
});

test("template application atomically creates ordinary Operations, routes, provenance, and events", async () => {
  const f = await fixture();
  const application = await f.service.applyWorkflowTemplate(f.started.assignment.assignmentId, { applicationId: "tapp-delivery-1", template, bindings: { affectedPaths: { implement: ["packages/api/**"] } } }, f.context);
  assert.equal(application.templateId, template.templateId);
  assert.equal(Object.keys(application.operationBindings).length, 3);
  const current = await f.repository.get(f.started.assignment.assignmentId);
  assert.equal(current?.tasks.length, 3);
  assert.equal(current?.routes?.length, 1);
  assert.equal(current?.templateApplications?.length, 1);
  assert.deepEqual(f.repository.events.filter((event) => event.type === "template.applied").map((event) => event.data.templateApplicationId), ["tapp-delivery-1"]);
  assert.equal(f.repository.events.filter((event) => event.type === "task.created").length, 3);
});

test("application IDs make retries idempotent and conflicting reuse fails", async () => {
  const f = await fixture();
  const first = await f.service.applyWorkflowTemplate(f.started.assignment.assignmentId, { applicationId: "tapp-idempotent", template }, f.context);
  const eventCount = f.repository.events.length;
  const second = await f.service.applyWorkflowTemplate(f.started.assignment.assignmentId, { applicationId: "tapp-idempotent", template }, f.context);
  assert.deepEqual(second, first);
  assert.equal(f.repository.events.length, eventCount);
  await assert.rejects(f.service.applyWorkflowTemplate(f.started.assignment.assignmentId, { applicationId: "tapp-idempotent", template: { ...template, version: "1.2.1" } }, f.context), /TEMPLATE_APPLICATION_CONFLICT/);
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.tasks.length, 3);
});

test("invalid templates fail without publishing partial Operations or events", async () => {
  const f = await fixture();
  const eventCount = f.repository.events.length;
  const cyclic = structuredClone(template);
  cyclic.operations[0]!.dependencies = [{ operation: "review" }];
  await assert.rejects(f.service.applyWorkflowTemplate(f.started.assignment.assignmentId, { applicationId: "tapp-invalid", template: cyclic }, f.context), /TASK_DEPENDENCY_CYCLE/);
  const current = await f.repository.get(f.started.assignment.assignmentId);
  assert.equal(current?.tasks.length, 0);
  assert.equal(current?.templateApplications?.length, 0);
  assert.equal(f.repository.events.length, eventCount);
});

test("template validation rejects drift, missing references, ambiguous targets, and invalid policies", () => {
  assert.throws(() => validateWorkflowTemplate({ ...template, surprise: true }), /unknown properties/);
  assert.throws(() => validateWorkflowTemplate({ ...template, version: "latest" }), /TEMPLATE_VERSION_INVALID/);
  assert.throws(() => validateWorkflowTemplate({ ...template, operations: [{ key: "one", affectedPaths: [] }] }), /role/);
  assert.throws(() => validateWorkflowTemplate({ ...template, operations: [{ key: "one", role: "implementation", affectedPaths: [], dependencies: [{ operation: "missing" }] }] }), /DEPENDENCY_MISSING/);
  assert.throws(() => validateWorkflowTemplate({ ...template, operations: [{ key: "one", role: "implementation", affectedPaths: [], runBudget: { arbitrary: 1 } }] }), /unknown properties/);
  assert.throws(() => validateWorkflowTemplate({ ...template, operations: [{ key: "one", role: "implementation", affectedPaths: [], retryPolicy: { maxAttempts: 2, backoffSeconds: [], extra: true } }] }), /unknown properties/);
  const ambiguous = structuredClone(template);
  ambiguous.routes!.push({ key: "also-remediate", sourceOperation: "implement", sourceKind: "execution", expectedValue: "failed", targetOperation: "remediate", effect: "activate" });
  assert.throws(() => validateWorkflowTemplate(ambiguous), /TARGET_AMBIGUOUS/);
});

test("bindings may change scope only for declared Operations", () => {
  assert.throws(() => expandWorkflowTemplate({ template, bindings: { affectedPaths: { unknown: ["src/**"] } }, createdAt: "2026-09-15T14:00:00.000Z", startingSequence: 1, taskId: () => "tsk-x", routeId: () => "rte-x", defaultRetryPolicy: { maxAttempts: 1, backoffSeconds: [] } }), /BINDING_UNKNOWN_OPERATION/);
  assert.throws(() => expandWorkflowTemplate({ template, bindings: { affectedPaths: { implement: [""] } }, createdAt: "2026-09-15T14:00:00.000Z", startingSequence: 1, taskId: () => "tsk-x", routeId: () => "rte-x", defaultRetryPolicy: { maxAttempts: 1, backoffSeconds: [] } }), /expected non-empty strings/);
});

test("template-assigned Crew role cannot be replaced at dispatch", async () => {
  const f = await fixture();
  const application = await f.service.applyWorkflowTemplate(f.started.assignment.assignmentId, { applicationId: "tapp-role", template }, f.context);
  await assert.rejects(f.service.beginManagedExecution(f.started.assignment.assignmentId, application.operationBindings.implement!, "security", {} as never, f.context), /TASK_ROLE_MISMATCH/);
  assert.equal((await f.repository.get(f.started.assignment.assignmentId))?.executions.length, 0);
});

test("template application rejects disabled Crew roles without partial state", async () => {
  const f = await fixture();
  const disabledRoleTemplate = structuredClone(template);
  disabledRoleTemplate.operations[0]!.role = "reliability";
  const eventCount = f.repository.events.length;
  await assert.rejects(
    f.service.applyWorkflowTemplate(f.started.assignment.assignmentId, { applicationId: "tapp-disabled-role", template: disabledRoleTemplate }, f.context),
    /TEMPLATE_ROLE_NOT_ENABLED: reliability/,
  );
  const current = await f.repository.get(f.started.assignment.assignmentId);
  assert.equal(current?.tasks.length, 0);
  assert.equal(current?.templateApplications?.length, 0);
  assert.equal(f.repository.events.length, eventCount);
});
