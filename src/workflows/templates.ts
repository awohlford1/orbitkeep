import { createHash } from "node:crypto";
import { canonicalJson } from "../config/index.ts";
import type { ConditionalRoute, ResourceBudget, RetryPolicy, RouteEffect, RouteSourceKind, TaskState } from "../commands/types.ts";
import { validateBudget, validateRetryPolicy, validateTaskGraph } from "../scheduling/index.ts";

export interface WorkflowTemplateDependency { operation: string; required?: boolean; acceptableStates?: Array<"accepted" | "closed"> }
export interface WorkflowTemplateGate { gateId: string; name: string; phase: "pre_dispatch" | "pre_acceptance"; required?: boolean }
export interface WorkflowTemplateOperation { key: string; role: string; affectedPaths: string[]; dependencies?: WorkflowTemplateDependency[]; gates?: WorkflowTemplateGate[]; runBudget?: ResourceBudget; retryPolicy?: RetryPolicy; priority?: number }
export interface WorkflowTemplateRoute { key: string; sourceOperation: string; sourceKind: RouteSourceKind; gateId?: string; expectedValue: string; targetOperation: string; effect: RouteEffect }
export interface WorkflowTemplateDefinition { schemaVersion: "1.0"; templateId: string; version: string; name: string; description?: string; operations: WorkflowTemplateOperation[]; routes?: WorkflowTemplateRoute[] }
export interface WorkflowTemplateBindings { affectedPaths?: Record<string, string[]> }
export interface WorkflowTemplateApplication { applicationId: string; templateId: string; templateVersion: string; templateDigest: string; templateSnapshot: WorkflowTemplateDefinition; bindings: WorkflowTemplateBindings; operationBindings: Record<string, string>; routeBindings: Record<string, string>; createdAt: string }
export interface ExpandedWorkflowTemplate { templateDigest: string; templateSnapshot: WorkflowTemplateDefinition; bindings: WorkflowTemplateBindings; tasks: TaskState[]; routes: ConditionalRoute[]; operationBindings: Record<string, string>; routeBindings: Record<string, string> }

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const templateIdPattern = /^tpl-[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const values: Record<RouteSourceKind, readonly string[]> = { execution: ["completed", "failed", "cancelled"], task: ["accepted", "rework", "closed", "cancelled", "skipped"], gate: ["passed", "failed", "waived"] };

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${code}: expected an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${code}: unknown properties ${unknown.join(", ")}`);
}

function strings(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${code}: expected non-empty strings`);
  return [...value] as string[];
}

function portable(value: unknown, code: string): string {
  if (typeof value !== "string" || !keyPattern.test(value)) throw new Error(`${code}: invalid portable key`);
  return value;
}

/** Validates untrusted JSON and returns a detached, normalized template. */
export function validateWorkflowTemplate(input: unknown): WorkflowTemplateDefinition {
  const root = object(input, "TEMPLATE_INVALID");
  exact(root, ["schemaVersion", "templateId", "version", "name", "description", "operations", "routes"], "TEMPLATE_INVALID");
  if (root.schemaVersion !== "1.0") throw new Error("TEMPLATE_SCHEMA_UNSUPPORTED: schemaVersion must be 1.0");
  if (typeof root.templateId !== "string" || !templateIdPattern.test(root.templateId)) throw new Error("TEMPLATE_ID_INVALID: templateId must use the tpl- prefix");
  if (typeof root.version !== "string" || !semverPattern.test(root.version)) throw new Error("TEMPLATE_VERSION_INVALID: version must be semantic versioning");
  if (typeof root.name !== "string" || !root.name.trim()) throw new Error("TEMPLATE_INVALID: name is required");
  if (root.description !== undefined && (typeof root.description !== "string" || !root.description.trim())) throw new Error("TEMPLATE_INVALID: description must be a non-empty string");
  if (!Array.isArray(root.operations) || root.operations.length === 0) throw new Error("TEMPLATE_INVALID: at least one Operation is required");

  const operationKeys = new Set<string>();
  const operations = root.operations.map((entry, index): WorkflowTemplateOperation => {
    const item = object(entry, `TEMPLATE_OPERATION_INVALID[${index}]`);
    exact(item, ["key", "role", "affectedPaths", "dependencies", "gates", "runBudget", "retryPolicy", "priority"], `TEMPLATE_OPERATION_INVALID[${index}]`);
    const key = portable(item.key, `TEMPLATE_OPERATION_INVALID[${index}].key`);
    const role = portable(item.role, `TEMPLATE_OPERATION_INVALID[${index}].role`);
    if (operationKeys.has(key)) throw new Error(`TEMPLATE_OPERATION_DUPLICATE: ${key}`);
    operationKeys.add(key);
    const affectedPaths = strings(item.affectedPaths, `TEMPLATE_OPERATION_INVALID[${index}].affectedPaths`);
    const dependencyKeys = new Set<string>();
    const dependencies = item.dependencies === undefined ? [] : (() => {
      if (!Array.isArray(item.dependencies)) throw new Error(`TEMPLATE_DEPENDENCY_INVALID: ${key} dependencies must be an array`);
      return item.dependencies.map((entry, dependencyIndex): WorkflowTemplateDependency => {
        const dependency = object(entry, `TEMPLATE_DEPENDENCY_INVALID[${dependencyIndex}]`);
        exact(dependency, ["operation", "required", "acceptableStates"], `TEMPLATE_DEPENDENCY_INVALID[${dependencyIndex}]`);
        const operation = portable(dependency.operation, `TEMPLATE_DEPENDENCY_INVALID[${dependencyIndex}].operation`);
        if (dependencyKeys.has(operation)) throw new Error(`TEMPLATE_DEPENDENCY_DUPLICATE: ${operation} on ${key}`);
        dependencyKeys.add(operation);
        if (dependency.required !== undefined && typeof dependency.required !== "boolean") throw new Error("TEMPLATE_DEPENDENCY_INVALID: required must be boolean");
        const acceptableStates = dependency.acceptableStates === undefined ? ["accepted", "closed"] as Array<"accepted" | "closed"> : strings(dependency.acceptableStates, "TEMPLATE_DEPENDENCY_INVALID: acceptableStates") as Array<"accepted" | "closed">;
        if (!acceptableStates.length || acceptableStates.some((state) => state !== "accepted" && state !== "closed") || new Set(acceptableStates).size !== acceptableStates.length) throw new Error("TEMPLATE_DEPENDENCY_INVALID: acceptableStates must contain unique accepted or closed values");
        return { operation, required: dependency.required ?? true, acceptableStates };
      });
    })();
    const gateIds = new Set<string>();
    const gates = item.gates === undefined ? [] : (() => {
      if (!Array.isArray(item.gates)) throw new Error(`TEMPLATE_GATE_INVALID: ${key} gates must be an array`);
      return item.gates.map((entry, gateIndex): WorkflowTemplateGate => {
        const gate = object(entry, `TEMPLATE_GATE_INVALID[${gateIndex}]`);
        exact(gate, ["gateId", "name", "phase", "required"], `TEMPLATE_GATE_INVALID[${gateIndex}]`);
        const gateId = portable(gate.gateId, `TEMPLATE_GATE_INVALID[${gateIndex}].gateId`);
        if (gateIds.has(gateId)) throw new Error(`TEMPLATE_GATE_DUPLICATE: ${gateId} on ${key}`);
        gateIds.add(gateId);
        if (typeof gate.name !== "string" || !gate.name.trim()) throw new Error("TEMPLATE_GATE_INVALID: name is required");
        if (gate.phase !== "pre_dispatch" && gate.phase !== "pre_acceptance") throw new Error("TEMPLATE_GATE_INVALID: phase must be pre_dispatch or pre_acceptance");
        if (gate.required !== undefined && typeof gate.required !== "boolean") throw new Error("TEMPLATE_GATE_INVALID: required must be boolean");
        return { gateId, name: gate.name, phase: gate.phase, required: gate.required ?? true };
      });
    })();
    const runBudget = item.runBudget === undefined ? undefined : (() => { const raw = object(item.runBudget, "TEMPLATE_RUN_BUDGET_INVALID"); exact(raw, ["inputTokens", "outputTokens", "totalTokens", "costMicros", "elapsedMs", "maxRuns"], "TEMPLATE_RUN_BUDGET_INVALID"); return structuredClone(raw) as ResourceBudget; })();
    validateBudget(runBudget, "TEMPLATE_RUN");
    if (runBudget?.maxRuns !== undefined) throw new Error("TEMPLATE_RUN_BUDGET_INVALID: maxRuns is only valid for Mission budgets");
    const retryPolicy = item.retryPolicy === undefined ? undefined : (() => { const raw = object(item.retryPolicy, "TEMPLATE_RETRY_POLICY_INVALID"); exact(raw, ["maxAttempts", "backoffSeconds"], "TEMPLATE_RETRY_POLICY_INVALID"); return structuredClone(raw) as unknown as RetryPolicy; })();
    if (retryPolicy) validateRetryPolicy(retryPolicy, "TEMPLATE_RETRY_POLICY");
    if (item.priority !== undefined && (!Number.isSafeInteger(item.priority) || typeof item.priority !== "number")) throw new Error("TEMPLATE_PRIORITY_INVALID: priority must be a safe integer");
    return { key, role, affectedPaths, dependencies, gates, ...(runBudget ? { runBudget } : {}), ...(retryPolicy ? { retryPolicy } : {}), ...(item.priority === undefined ? {} : { priority: item.priority as number }) };
  });

  for (const operation of operations) for (const dependency of operation.dependencies ?? []) {
    if (!operationKeys.has(dependency.operation)) throw new Error(`TEMPLATE_DEPENDENCY_MISSING: ${dependency.operation}`);
    if (dependency.operation === operation.key) throw new Error(`TEMPLATE_DEPENDENCY_INVALID: ${operation.key} cannot depend on itself`);
  }

  const routeKeys = new Set<string>(), routeTargets = new Set<string>();
  const routes = root.routes === undefined ? [] : (() => {
    if (!Array.isArray(root.routes)) throw new Error("TEMPLATE_ROUTE_INVALID: routes must be an array");
    return root.routes.map((entry, index): WorkflowTemplateRoute => {
      const route = object(entry, `TEMPLATE_ROUTE_INVALID[${index}]`);
      exact(route, ["key", "sourceOperation", "sourceKind", "gateId", "expectedValue", "targetOperation", "effect"], `TEMPLATE_ROUTE_INVALID[${index}]`);
      const key = portable(route.key, `TEMPLATE_ROUTE_INVALID[${index}].key`), sourceOperation = portable(route.sourceOperation, `TEMPLATE_ROUTE_INVALID[${index}].sourceOperation`), targetOperation = portable(route.targetOperation, `TEMPLATE_ROUTE_INVALID[${index}].targetOperation`);
      if (routeKeys.has(key)) throw new Error(`TEMPLATE_ROUTE_DUPLICATE: ${key}`); routeKeys.add(key);
      if (!operationKeys.has(sourceOperation)) throw new Error(`TEMPLATE_ROUTE_SOURCE_MISSING: ${sourceOperation}`);
      if (!operationKeys.has(targetOperation)) throw new Error(`TEMPLATE_ROUTE_TARGET_MISSING: ${targetOperation}`);
      if (sourceOperation === targetOperation) throw new Error("TEMPLATE_ROUTE_SELF_REFERENCE: source and target Operations must differ");
      if (routeTargets.has(targetOperation)) throw new Error(`TEMPLATE_ROUTE_TARGET_AMBIGUOUS: ${targetOperation} has multiple incoming routes`); routeTargets.add(targetOperation);
      if (route.sourceKind !== "execution" && route.sourceKind !== "task" && route.sourceKind !== "gate") throw new Error("TEMPLATE_ROUTE_INVALID: invalid sourceKind");
      if (typeof route.expectedValue !== "string" || !values[route.sourceKind].includes(route.expectedValue)) throw new Error("TEMPLATE_ROUTE_EXPECTED_VALUE_INVALID");
      if (route.effect !== "activate" && route.effect !== "skip" && route.effect !== "block" && route.effect !== "cancel") throw new Error("TEMPLATE_ROUTE_INVALID: invalid effect");
      let gateId: string | undefined;
      if (route.sourceKind === "gate") {
        gateId = portable(route.gateId, "TEMPLATE_ROUTE_GATE_REQUIRED");
        const source = operations.find((operation) => operation.key === sourceOperation)!;
        if (!(source.gates ?? []).some((gate) => gate.gateId === gateId)) throw new Error(`TEMPLATE_ROUTE_GATE_MISSING: ${gateId}`);
      } else if (route.gateId !== undefined) throw new Error("TEMPLATE_ROUTE_GATE_INVALID: gateId is only valid for gate routes");
      return { key, sourceOperation, sourceKind: route.sourceKind, ...(gateId ? { gateId } : {}), expectedValue: route.expectedValue, targetOperation, effect: route.effect };
    });
  })();
  return { schemaVersion: "1.0", templateId: root.templateId, version: root.version, name: root.name, ...(root.description ? { description: root.description as string } : {}), operations, routes };
}

/** Expands a validated template into ordinary canonical workflow state. */
export function expandWorkflowTemplate(input: { template: unknown; bindings?: WorkflowTemplateBindings | undefined; createdAt: string; startingSequence: number; taskId: () => string; routeId: () => string; defaultRetryPolicy: RetryPolicy }): ExpandedWorkflowTemplate {
  const template = validateWorkflowTemplate(input.template);
  const rawBindings = object(input.bindings ?? {}, "TEMPLATE_BINDINGS_INVALID");
  exact(rawBindings, ["affectedPaths"], "TEMPLATE_BINDINGS_INVALID");
  const affected = rawBindings.affectedPaths === undefined ? {} : object(rawBindings.affectedPaths, "TEMPLATE_BINDINGS_INVALID: affectedPaths");
  const keys = new Set(template.operations.map((operation) => operation.key));
  for (const key of Object.keys(affected)) if (!keys.has(key)) throw new Error(`TEMPLATE_BINDING_UNKNOWN_OPERATION: ${key}`);
  const bindings: WorkflowTemplateBindings = { affectedPaths: Object.fromEntries(Object.entries(affected).map(([key, value]) => [key, strings(value, `TEMPLATE_BINDINGS_INVALID: ${key}`)])) };
  const operationBindings = Object.fromEntries(template.operations.map((operation) => [operation.key, input.taskId()]));
  const incomingTargets = new Set((template.routes ?? []).map((route) => route.targetOperation));
  const tasks = template.operations.map((operation, index): TaskState => ({
    taskId: operationBindings[operation.key]!, state: incomingTargets.has(operation.key) ? "draft" : "ready", role: operation.role, affectedPaths: bindings.affectedPaths?.[operation.key] ?? [...operation.affectedPaths], executionIds: [], resultIds: [],
    dependencies: (operation.dependencies ?? []).map((dependency) => ({ taskId: operationBindings[dependency.operation]!, required: dependency.required ?? true, acceptableStates: dependency.acceptableStates ?? ["accepted", "closed"] })),
    gates: (operation.gates ?? []).map((gate) => ({ gateId: gate.gateId, name: gate.name, phase: gate.phase, required: gate.required ?? true, status: "pending", evidenceIds: [] })),
    ...(operation.runBudget ? { runBudget: structuredClone(operation.runBudget) } : {}), retryPolicy: structuredClone(operation.retryPolicy ?? input.defaultRetryPolicy), priority: operation.priority ?? 0, createdSequence: input.startingSequence + index,
  }));
  validateTaskGraph(tasks);
  const routeBindings = Object.fromEntries((template.routes ?? []).map((route) => [route.key, input.routeId()]));
  const routes = (template.routes ?? []).map((route): ConditionalRoute => ({ routeId: routeBindings[route.key]!, sourceTaskId: operationBindings[route.sourceOperation]!, sourceKind: route.sourceKind, ...(route.gateId ? { gateId: route.gateId } : {}), expectedValue: route.expectedValue, targetTaskId: operationBindings[route.targetOperation]!, effect: route.effect, state: "pending", createdAt: input.createdAt }));
  const templateSnapshot = structuredClone(template), normalizedBindings = structuredClone(bindings);
  return { templateDigest: `sha256:${createHash("sha256").update(canonicalJson(templateSnapshot)).digest("hex")}`, templateSnapshot, bindings: normalizedBindings, tasks, routes, operationBindings, routeBindings };
}
