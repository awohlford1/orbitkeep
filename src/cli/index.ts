#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyAssignmentArchive, planAssignmentArchive } from "../archive/index.ts";
import { applyRawResponseCleanup, planRawResponseCleanup } from "../cleanup/index.ts";
import { AssignmentSelectionError, resolveAssignmentReference, WorkflowCommandService, StateWorkflowRepository, runConsequentialOperation, type CommandResponse } from "../commands/index.ts";
import { loadEffectiveConfiguration } from "../config/index.ts";
import { MANAGED_WORKFLOW_COMMANDS, type ActorRef } from "../contracts/index.ts";
import { applyRepair, applyUpgrade, deriveSiloConsumer, installConsumer, findConsumerRoot, installationStateDirectory, listInstallationTransactions, planInstallationTransactionCleanup, planRepair, planUpgrade, pruneInstallationTransactions, recoverInterruptedTransactions, rollbackInstallationTransaction, rollbackUpgrade, upgradeStatus } from "../installer/index.ts";
import { appendEvent } from "../events/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { initializeStateRoot, writeJsonAtomic } from "../storage/index.ts";
import type { JsonValue } from "../storage/index.ts";
import { capabilityReport, checkUpgradeCompatibility, doctor, FRAMEWORK_VERSION, providerDoctor, SUPPORTED_SCHEMA_VERSION, validateInstallation } from "./diagnostics.ts";
import { ClaudeProviderAdapter } from "../providers/claude/index.ts";
import { CodexProviderAdapter } from "../providers/codex/index.ts";
import { persistRedactedRawResponse } from "../providers/index.ts";
import { quarantineSubmission, readQuarantineSubmission, resolveQuarantine } from "../reconciliation/index.ts";
import { acknowledgeHandover, bindBrokeredSession, controlStatus, flightPlanPrompt, getProviderManagerIdentity, handoverPackageId, inspectSupervisor, interruptBrokeredSessions, interruptControlledExecution, isBrokeredBootstrapOperation, isBrokeredManagementOperation, isBrokeredReadOnlyOperation, isHandoverAcknowledged, isParentOwnedLifecycleMutation, launchControlledCli, launchSupervisorJob, markResponseCaptureObserved, missionExecutionPrompt, parseGeneratedFlightPlan, readSupervisorEvents, resolveBrokeredSession, runHeadlessProvider, serveSupervisor, shutdownSupervisor, supervisorJobs, type BrokeredSessionRecord, type HeadlessProviderEvent, type SessionProvider } from "../control/index.ts";
import type { NormalizedProviderSignal } from "../providers/claude/index.ts";
import { captureGitWorkspaceSnapshot } from "../evidence/index.ts";
import type { SignedExecutiveApprovalReceipt } from "../approvals/index.ts";
import { formatCliOutput, selectOutputMode, type OutputMode } from "./presentation.ts";
import { assertSupportedRuntimeEnvironment } from "./runtime-environment.ts";
import { JIRA_ACTION_AUTHORITIES, JIRA_TRANSITION_FALLBACKS, JIRA_WORK_INTENTS, JiraCloudReadClient, SystemJiraSecretStore, bindJiraTask, executeJiraIntent, inspectJiraWorkflow, jiraConfigurationHealthAsync, jiraKeychainReference, jiraTaskBinding, resolveJiraCredentialAsync, type JiraActionAuthority, type JiraTransitionFallback, type JiraWorkflowProfile, type JiraWorkIntent } from "../integrations/jira/index.ts";

type Input = Record<string, unknown>;
function redactOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactOutput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === "token" || key === "ownershipToken" ? "[REDACTED]" : redactOutput(item),
    ]));
  }
  return value;
}
let activeCommand = "command";
let activeOutputMode: OutputMode = "json";
const output = (value: unknown, failed = false) => {
  const safe = process.argv.includes("--redact-output") ? redactOutput(value) : value;
  const rendered = formatCliOutput({ command: activeCommand, value: safe, mode: activeOutputMode, failed });
  if (!rendered) return;
  (rendered.stream === "stderr" ? process.stderr : process.stdout).write(rendered.text);
};

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  return value !== undefined && !value.startsWith("-") ? value : undefined;
}
function inlineJsonInput(): string | undefined {
  const at = process.argv.indexOf("--json");
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  return value?.trimStart().startsWith("{") || value?.trimStart().startsWith("[") ? value : undefined;
}
async function jsonInput(): Promise<Input> {
  const inline = inlineJsonInput();
  if (inline) return JSON.parse(inline) as Input;
  if (process.stdin.isTTY) return {};
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() === "" ? {} : JSON.parse(text) as Input;
}
function required(input: Input, key: string): string {
  const value = input[key] ?? option(key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`));
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}
function actor(input: Input): ActorRef {
  const type = String(input.actorType ?? "manager") as ActorRef["actorType"];
  return { actorId: String(input.actorId ?? (type === "executive" ? "executive:local" : "manager:local")), actorType: type };
}
function adapter(root: string, stateDirectory: string) {
  return {
    async requestStop(input: { executionId: string; mode: "graceful" | "force"; timeoutMs?: number }) {
      const { stateRoot } = await initializeStateRoot(root, stateDirectory);
      const result = await interruptControlledExecution(stateRoot, input.executionId, input.mode, input.timeoutMs);
      return result.confirmed && result.checkpointId ? { confirmed: true, checkpointId: result.checkpointId } : { confirmed: result.confirmed };
    },
    async createTransferPackage(input: { assignment: { assignmentId: string; executions: Array<{ executionId: string; state: string }> }; receiverManagerInstanceId: string }) { const { stateRoot } = await initializeStateRoot(root, stateDirectory); const states = await Promise.all(input.assignment.executions.map(async (execution) => ({ execution, control: await controlStatus(stateRoot, execution.executionId) }))); return { packageId: handoverPackageId(input.assignment.assignmentId, input.receiverManagerInstanceId), valid: states.every(({ execution, control }) => execution.state !== "running" && execution.state !== "unknown" && (control === undefined || control.status === "stopped")) }; },
    async transferOwnership(input: { assignmentId: string; receiverManagerInstanceId: string }) { const { stateRoot } = await initializeStateRoot(root, stateDirectory); return { accepted: await isHandoverAcknowledged(stateRoot, input.assignmentId, input.receiverManagerInstanceId) }; },
  };
}
async function service(root: string) {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const repository = new StateWorkflowRepository({ projectRoot: root, stateDirectory: effective.config.state.directory, policySnapshot: { configuration_digest: effective.digest } });
  const maxConcurrentOperations = effective.machine.concurrency?.maxOperations;
  return { service: new WorkflowCommandService(repository, effective.config, adapter(root, effective.config.state.directory), maxConcurrentOperations === undefined ? {} : { maxConcurrentOperations }), repository, effective };
}
function context(input: Input) {
  return { actor: actor(input), managerInstanceId: String(input.managerInstanceId ?? process.env.ORBITKEEP_MANAGER_INSTANCE_ID ?? "mgr-local"), ...(typeof input.ownershipToken === "string" ? { ownershipToken: input.ownershipToken } : {}) };
}

async function prepareMissionRun(current: Awaited<ReturnType<typeof service>>, assignment: CommandResponse["assignment"], ownershipToken: string, root: string) {
  const ctx = { actor: { actorId: assignment.managerInstanceId, actorType: "manager" as const }, managerInstanceId: assignment.managerInstanceId, ownershipToken };
  const task = await current.service.createTask(assignment.assignmentId, [], ctx);
  await current.service.transitionTask(assignment.assignmentId, task.taskId, "ready", ctx);
  const snapshot = await captureGitWorkspaceSnapshot(root).catch(() => undefined);
  const execution = await current.service.beginExecution(assignment.assignmentId, task.taskId, ctx, undefined, snapshot);
  return { taskId: task.taskId, executionId: execution.executionId };
}

async function failPreparedMissionRun(current: Awaited<ReturnType<typeof service>>, assignment: CommandResponse["assignment"], ownershipToken: string, executionId: string, root: string) {
  const ctx = { actor: { actorId: assignment.managerInstanceId, actorType: "manager" as const }, managerInstanceId: assignment.managerInstanceId, ownershipToken };
  const snapshot = await captureGitWorkspaceSnapshot(root).catch(() => undefined);
  await current.service.recordExecutionOutcome(assignment.assignmentId, executionId, "failed", ctx, snapshot).catch(() => undefined);
}

function approvalReceipt(input: Input): SignedExecutiveApprovalReceipt | undefined {
  return input.approvalReceipt && typeof input.approvalReceipt === "object" ? input.approvalReceipt as SignedExecutiveApprovalReceipt : undefined;
}

/**
 * Persists a short-retention, redacted transcript entry for a framework-mediated
 * interaction. This is deliberately a managed, fenced write: raw diagnostic
 * material must be attributable to the current assignment owner, while the
 * content itself never appears in the command result or event payload.
 */
async function recordTranscript(root: string, current: Awaited<ReturnType<typeof service>>, input: Input, ctx: ReturnType<typeof context>) {
  const assignmentId = required(input, "assignmentId");
  const ownershipToken = ctx.ownershipToken;
  if (!ownershipToken) throw new Error("OWNERSHIP_REQUIRED: transcript-record requires a valid ownership token");
  await current.repository.validateOwnership?.(assignmentId, ctx.managerInstanceId, ownershipToken, new Date());

  const responseId = `raw-${randomUUID()}`;
  const kind = required(input, "kind");
  const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  const rawResponsePath = await persistRedactedRawResponse(stateRoot, {
    responseId,
    provider: "framework",
    sourceEvent: kind,
    content: input.content ?? {},
    retentionDays: current.effective.config.retention.rawResponsesDays,
    assignmentId,
    ...(typeof input.taskId === "string" ? { taskId: input.taskId } : {}),
    ...(typeof input.executionId === "string" ? { executionId: input.executionId } : {}),
  });
  await appendEvent({
    projectRoot: root, stateDirectory: current.effective.config.state.directory, operationId: `op-${randomUUID()}`,
    validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event",
    event: {
      schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: "provider.signal_observed", occurred_at: new Date().toISOString(),
      actor: { actor_id: ctx.actor.actorId, actor_type: ctx.actor.actorType },
      recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" },
      assignment_id: assignmentId,
      ...(typeof input.taskId === "string" ? { task_id: input.taskId } : {}),
      ...(typeof input.executionId === "string" ? { execution_id: input.executionId } : {}),
      provider_context: { provider: "framework" },
      data: { provider: "framework", signal: "transcript.recorded", details: { response_id: responseId, kind, retention_days: current.effective.config.retention.rawResponsesDays } },
    },
  });
  return { status: "succeeded", code: "TRANSCRIPT_RECORDED", responseId, rawResponsePath, retentionDays: current.effective.config.retention.rawResponsesDays };
}

async function managedQuarantine(root: string, current: Awaited<ReturnType<typeof service>>, command: "quarantine-submit" | "quarantine-show" | "quarantine-resolve", input: Input, ctx: ReturnType<typeof context>) {
  const assignmentId = required(input, "assignmentId");
  if (command !== "quarantine-show") {
    if (!ctx.ownershipToken) throw new Error("OWNERSHIP_REQUIRED: quarantine changes require an ownership token");
    await current.repository.validateOwnership?.(assignmentId, ctx.managerInstanceId, ctx.ownershipToken, new Date());
  }
  const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  const quarantineId = required(input, "quarantineId");
  if (command === "quarantine-show") return (await readQuarantineSubmission(stateRoot, quarantineId)) ?? { status: "not_found", quarantineId };
  if (command === "quarantine-submit") {
    const errors = input.validationErrors;
    if (!Array.isArray(errors) || errors.length === 0) throw new Error("VALIDATION_ERRORS_REQUIRED: quarantine requires one or more validation errors");
    const record = { schema_version: "1.0" as const, record_id: quarantineId, record_type: "quarantine" as const, created_at: new Date().toISOString(), quarantine_id: quarantineId, submission: (input.submission ?? {}) as JsonValue, validation_errors: errors, status: "unresolved" as const };
    const location = await quarantineSubmission(stateRoot, record as never);
    await appendEvent({ projectRoot: root, stateDirectory: current.effective.config.state.directory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: { schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: "submission.rejected", occurred_at: new Date().toISOString(), actor: { actor_id: ctx.actor.actorId, actor_type: ctx.actor.actorType }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, assignment_id: assignmentId, data: { submission_id: quarantineId } } });
    return { status: "quarantined", quarantineId, location };
  }
  const resolution = required(input, "resolution"); const disposition = required(input, "disposition");
  if (disposition !== "corrected" && disposition !== "dismissed") throw new Error("QUARANTINE_DISPOSITION_INVALID");
  const location = await resolveQuarantine(stateRoot, { schema_version: "1.0", quarantine_id: quarantineId, resolution_id: `qres-${randomUUID()}`, disposition, resolved_at: new Date().toISOString(), actor_id: ctx.actor.actorId, rationale: resolution, ...(typeof input.replacementRecordId === "string" ? { replacement_record_id: input.replacementRecordId } : {}) });
  await appendEvent({ projectRoot: root, stateDirectory: current.effective.config.state.directory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: { schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: "quarantine.resolved", occurred_at: new Date().toISOString(), actor: { actor_id: ctx.actor.actorId, actor_type: ctx.actor.actorType }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, assignment_id: assignmentId, data: { record_ref: { record_type: "quarantine", record_id: quarantineId } } } });
  return { status: "resolved", quarantineId, location };
}

async function executeManagerCommand(root: string, command: string, input: Input): Promise<unknown> {
  const current = await service(root); const ctx = context(input); const svc = current.service;
  if (command !== "start" && (typeof input.assignmentId !== "string" || input.assignmentId.length === 0)) {
    input = { ...input, assignmentId: await resolveAssignmentReference({ repository: current.repository, command, managerInstanceId: ctx.managerInstanceId }) };
  }
  switch (command) {
    case "start": {
      if (input.waiveApproval === true && current.effective.config.security.executiveApproval.mode === "signed_ed25519") throw new Error("SIGNED_WAIVER_REQUIRES_APPROVAL_ID: start first, then use waive-plan with a signed receipt");
      return svc.start({ objective: required(input, "objective"), approach: (input.approach ?? []) as string[], acceptanceCriteria: (input.acceptanceCriteria ?? []) as string[], waiveApproval: input.waiveApproval === true, ...(input.budget && typeof input.budget === "object" ? { budget: input.budget as never } : {}) }, ctx);
    }
    case "resume": {
      if (input.waiveApproval === true && current.effective.config.security.executiveApproval.mode === "signed_ed25519") throw new Error("SIGNED_WAIVER_REQUIRES_APPROVAL_ID: resume without waiver, then use waive-plan with a signed receipt");
      return svc.resume({ assignmentId: required(input, "assignmentId"), waiveApproval: input.waiveApproval === true }, ctx);
    }
    case "status": return svc.status(required(input, "assignmentId"), ctx);
    case "ask": return svc.ask(required(input, "assignmentId"), required(input, "question"), ctx);
    case "steer": return svc.steer({ assignmentId: required(input, "assignmentId"), paths: (input.paths ?? []) as string[], rationale: required(input, "rationale"), approach: (input.approach ?? []) as string[], acceptanceCriteria: (input.acceptanceCriteria ?? []) as string[] }, ctx);
    case "pause": return svc.pause({ assignmentId: required(input, "assignmentId"), ...(input.mode ? { mode: input.mode as "graceful" | "force" } : {}), ...(input.timeoutMs === undefined ? {} : { timeoutMs: Number(input.timeoutMs) }) }, ctx);
    case "handover": return svc.handover({ assignmentId: required(input, "assignmentId"), receiverManagerInstanceId: required(input, "receiverManagerInstanceId"), ...(input.mode ? { mode: input.mode as "graceful" | "force" } : {}) }, ctx);
    case "approve-plan": return svc.approvePlan(required(input, "assignmentId"), required(input, "approvalId"), actor(input), ctx, approvalReceipt(input));
    case "reject-plan": return svc.rejectPlan(required(input, "assignmentId"), required(input, "approvalId"), actor(input), required(input, "reason"), ctx, approvalReceipt(input));
    case "waive-plan": return svc.waivePlanApproval(required(input, "assignmentId"), required(input, "approvalId"), actor(input), ctx, approvalReceipt(input));
    case "task-create": {
      const task = await svc.createTask(required(input, "assignmentId"), (input.affectedPaths ?? []) as string[], ctx, { ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies as never }), ...(input.gates === undefined ? {} : { gates: input.gates as never }), ...(input.runBudget && typeof input.runBudget === "object" ? { runBudget: input.runBudget as never } : {}), ...(input.retryPolicy && typeof input.retryPolicy === "object" ? { retryPolicy: input.retryPolicy as never } : {}), ...(input.priority === undefined ? {} : { priority: Number(input.priority) }) });
      if (typeof input.jiraIssueKey === "string") await bindJiraTaskCommand(root, { ...input, taskId: task.taskId, issueKey: input.jiraIssueKey });
      return task;
    }
    case "task-transition": {
      const taskId = required(input, "taskId"); const state = required(input, "state");
      const priorState = (await current.repository.get(required(input, "assignmentId")))?.tasks.find((task) => task.taskId === taskId)?.state;
      const task = state === "cancelled"
        ? await svc.cancelTask(required(input, "assignmentId"), taskId, { ...(input.mode === undefined ? {} : { mode: input.mode as "graceful" | "force" }), ...(input.timeoutMs === undefined ? {} : { timeoutMs: Number(input.timeoutMs) }) }, ctx)
        : await svc.transitionTask(required(input, "assignmentId"), taskId, state as never, ctx);
      const intent = state === "running" ? priorState === "blocked" ? "work_resumed" : "work_started" : state === "blocked" ? "work_blocked" : state === "cancelled" ? "work_cancelled" : undefined;
      if (intent) await synchronizeBoundJiraTask(root, input, taskId, intent);
      return task;
    }
    case "task-gate": return svc.recordTaskGateOutcome(required(input, "assignmentId"), required(input, "taskId"), required(input, "gateId"), required(input, "status") as "passed" | "failed" | "waived", (input.evidenceIds ?? []) as string[], ctx);
    case "route-create": return svc.createConditionalRoute(required(input, "assignmentId"), { sourceTaskId: required(input, "sourceTaskId"), sourceKind: required(input, "sourceKind") as "execution" | "task" | "gate", ...(typeof input.gateId === "string" ? { gateId: input.gateId } : {}), expectedValue: required(input, "expectedValue"), targetTaskId: required(input, "targetTaskId"), effect: required(input, "effect") as "activate" | "skip" | "block" | "cancel" }, ctx);
    case "route-evaluate": return svc.evaluateConditionalRoute(required(input, "assignmentId"), required(input, "routeId"), ctx);
    case "template-apply": {
      if (input.template === null || typeof input.template !== "object" || Array.isArray(input.template)) throw new Error("TEMPLATE_REQUIRED: template must be an object");
      if (input.bindings !== undefined && (input.bindings === null || typeof input.bindings !== "object" || Array.isArray(input.bindings))) throw new Error("TEMPLATE_BINDINGS_INVALID: bindings must be an object");
      return svc.applyWorkflowTemplate(required(input, "assignmentId"), { applicationId: required(input, "applicationId"), template: input.template as never, ...(input.bindings === undefined ? {} : { bindings: input.bindings as never }) }, ctx);
    }
    case "execution-begin": {
      if (input.taskPacket === undefined || input.taskPacket === null || typeof input.taskPacket !== "object") {
        throw new Error("TASK_PACKET_REQUIRED: manager-dispatched executions require a validated taskPacket");
      }
      const packet = input.taskPacket as Record<string, unknown>;
      if (input.controlLaunch === undefined || input.controlLaunch === null || typeof input.controlLaunch !== "object") {
        throw new Error("CONTROL_LAUNCH_REQUIRED: manager-dispatched executions require a provider CLI launch specification");
      }
      const launch = input.controlLaunch as Record<string, unknown>;
      const provider = required(launch, "provider");
      if (provider !== "codex" && provider !== "claude") throw new Error("CONTROL_PROVIDER_INVALID: provider must be codex or claude");
      if (!Array.isArray(launch.args) || !launch.args.every((value) => typeof value === "string")) throw new Error("CONTROL_ARGS_INVALID: controlLaunch.args must be an array of strings");
      const execution = await svc.beginManagedExecution(
        required(input, "assignmentId"),
        required(input, "taskId"),
        required(packet, "purpose"),
        packet as never,
        ctx,
        await captureGitWorkspaceSnapshot(root),
      );
      try {
        const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
        if (!ctx.ownershipToken) throw new Error("OWNERSHIP_REQUIRED: controlled execution launch requires the current ownership token");
        await launchControlledCli(stateRoot, { provider, assignmentId: required(input, "assignmentId"), executionId: execution.executionId, taskId: required(input, "taskId"), args: launch.args as string[], managerInstanceId: ctx.managerInstanceId, ownershipToken: ctx.ownershipToken, retentionDays: current.effective.config.retention.rawResponsesDays });
      } catch (error) {
        await svc.recordExecutionOutcome(required(input, "assignmentId"), execution.executionId, "failed", ctx, await captureGitWorkspaceSnapshot(root));
        throw error;
      }
      return execution;
    }
    case "execution-outcome": return svc.recordExecutionOutcome(required(input, "assignmentId"), required(input, "executionId"), required(input, "outcome") as never, ctx, await captureGitWorkspaceSnapshot(root));
    case "execution-retry": return svc.scheduleExecutionRetry(required(input, "assignmentId"), required(input, "taskId"), required(input, "executionId"), ctx);
    case "usage-record": return svc.recordUsageObservation(required(input, "assignmentId"), { observationId: required(input, "observationId"), taskId: required(input, "taskId"), executionId: required(input, "executionId"), provider: required(input, "provider"), model: required(input, "model"), measurement: required(input, "measurement") as "observed" | "estimated", inputTokens: Number(input.inputTokens), outputTokens: Number(input.outputTokens), ...(input.cachedInputTokens === undefined ? {} : { cachedInputTokens: Number(input.cachedInputTokens) }), costMicros: Number(input.costMicros), ...(typeof input.observedAt === "string" ? { observedAt: input.observedAt } : {}) }, ctx);
    case "result-submit": return svc.submitResult(required(input, "assignmentId"), required(input, "taskId"), required(input, "resultId"), ctx, { executionId: required(input, "executionId"), deliveryStatus: required(input, "deliveryStatus") as "complete" | "partial" | "failed", summary: required(input, "summary") });
    case "result-rework": { const taskId = required(input, "taskId"); const result = await svc.requestRework(required(input, "assignmentId"), taskId, ctx); await synchronizeBoundJiraTask(root, input, taskId, "rework_requested"); return result; }
    case "result-accept": { const taskId = required(input, "taskId"); const result = await svc.acceptResult(required(input, "assignmentId"), taskId, ctx); await synchronizeBoundJiraTask(root, input, taskId, "work_completed"); return result; }
    case "task-close": return svc.closeTask(required(input, "assignmentId"), required(input, "taskId"), ctx);
    case "action-create": return svc.createAction(required(input, "assignmentId"), required(input, "description"), ctx);
    case "action-outcome": return svc.recordActionOutcome(required(input, "assignmentId"), required(input, "actionId"), required(input, "outcome") as never, ctx);
    case "action-reconcile": return svc.reconcileAction(required(input, "assignmentId"), required(input, "actionId"), required(input, "outcome") as never, ctx);
    case "decision-record": return svc.recordDecision(required(input, "assignmentId"), required(input, "choice"), required(input, "rationale"), ctx);
    case "cancel": return svc.cancelAssignment(required(input, "assignmentId"), ctx);
    case "close": return svc.closeAssignment(required(input, "assignmentId"), ctx);
    case "reopen": return svc.reopenAssignment(required(input, "assignmentId"), ctx);
    case "ownership-acquire": return svc.acquireOwnership(required(input, "assignmentId"), ctx);
    case "transcript-record": return recordTranscript(root, current, input, ctx);
    case "quarantine-submit": return managedQuarantine(root, current, "quarantine-submit", input, ctx);
    case "quarantine-show": return managedQuarantine(root, current, "quarantine-show", input, ctx);
    case "quarantine-resolve": return managedQuarantine(root, current, "quarantine-resolve", input, ctx);
    default: throw new Error(`Unknown workflow command: ${command}`);
  }
}

async function managerCommand(root: string, command: string, input: Input): Promise<unknown> {
  if (!(MANAGED_WORKFLOW_COMMANDS as readonly string[]).includes(command)) throw new Error(`Unknown workflow command: ${command}`);
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const { stateRoot } = await initializeStateRoot(root, effective.config.state.directory);
  const brokeredSession = await resolveBrokeredSession(stateRoot, process.env);
  if (brokeredSession && ["approve-plan", "reject-plan", "waive-plan"].includes(command)) {
    throw Object.assign(new Error("Executive plan decisions must be submitted through the Orbitkeep parent control channel, not from a managed provider process."), { code: "EXECUTIVE_CHANNEL_REQUIRED" });
  }
  if (brokeredSession && input.actorType === "executive") {
    throw Object.assign(new Error("A managed provider process cannot assert Executive identity."), { code: "EXECUTIVE_CHANNEL_REQUIRED" });
  }
  if (brokeredSession && isParentOwnedLifecycleMutation(brokeredSession, command, input)) {
    throw Object.assign(new Error("The parent Orbitkeep control process owns this Mission wrapper lifecycle. Return work through the provider response instead."), { code: "PARENT_LIFECYCLE_OWNED" });
  }
  if (brokeredSession) input = {
    ...input,
    managerInstanceId: brokeredSession.manager_instance_id,
    ...(input.actorId === undefined && input.actorType === undefined ? { actorId: brokeredSession.manager_instance_id, actorType: "manager" } : {}),
    ...(brokeredSession.assignment_id && typeof input.assignmentId !== "string" ? { assignmentId: brokeredSession.assignment_id } : {}),
    ...(brokeredSession.ownership_token && typeof input.ownershipToken !== "string" ? { ownershipToken: brokeredSession.ownership_token } : {}),
  };
  const commandId = `cmd-${randomUUID()}`;
  const write = async (eventType: "manager.command_received" | "manager.command_accepted" | "manager.command_completed" | "manager.command_failed", details?: Record<string, unknown>) => {
    const who = actor(input);
    await appendEvent({ projectRoot: root, stateDirectory: effective.config.state.directory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: {
      schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: eventType, occurred_at: new Date().toISOString(),
      actor: { actor_id: who.actorId, actor_type: who.actorType }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" },
      ...(typeof input.assignmentId === "string" ? { assignment_id: input.assignmentId } : {}),
      data: { command_id: commandId, command, ...(details === undefined ? {} : { details: details as unknown as JsonValue }) },
    } });
  };
  await write("manager.command_received");
  await write("manager.command_accepted");
  try {
    const execute = () => executeManagerCommand(root, command, input);
    let result: unknown;
    if (["status", "ask"].includes(command)) result = await execute();
    else {
      const guarded = await durableMaintenance(
        stateRoot,
        `operation-${commandId}`,
        execute,
        effective.config.intentLogging.retryCount,
        effective.config.intentLogging.backoffSeconds,
      );
      if (guarded.status !== "succeeded") {
        throw guarded.error instanceof Error
          ? guarded.error
          : new Error(`Managed command ${command} ended with ${guarded.status}`);
      }
      result = guarded.value;
    }
    if (brokeredSession && result !== null && typeof result === "object") {
      const assignment = (result as { assignment?: unknown }).assignment;
      if (assignment !== null && typeof assignment === "object") {
        const value = assignment as { assignmentId?: unknown; ownershipLease?: { token?: unknown } };
        if (typeof value.assignmentId === "string" && typeof value.ownershipLease?.token === "string") {
          await bindBrokeredSession(stateRoot, process.env, { assignmentId: value.assignmentId, ownershipToken: value.ownershipLease.token });
        }
      }
    }
    await write("manager.command_completed");
    return result;
  } catch (error) {
    await write("manager.command_failed", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function durableMaintenance<T>(stateRoot: string, operationId: string, perform: () => Promise<T>, retryCount: number, backoffSeconds: number[]) {
  return runConsequentialOperation({
    operationId,
    async persistIntent(attempt) { await writeJsonAtomic(stateRoot, path.join("validations", `${operationId}.intent.json`), { operation_id: operationId, status: "intent_recorded", attempt, recorded_at: new Date().toISOString() }); },
    perform,
    async persistOutcome(outcome) { await writeJsonAtomic(stateRoot, path.join("validations", `${operationId}.outcome.json`), { operation_id: operationId, outcome, recorded_at: new Date().toISOString() }); },
    isTransient(error) { return ["EBUSY", "EAGAIN", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""); },
  }, { retryCount, backoffSeconds });
}

async function archiveCommand(root: string, input: Input, mode: "dry-run" | "apply") {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const { stateRoot } = await initializeStateRoot(root, effective.config.state.directory);
  const assignmentId = typeof input.assignmentId === "string" ? input.assignmentId : undefined;
  if (!assignmentId && typeof input.batchId === "string") throw new Error("batchId requires assignmentId");
  const assignmentIds = assignmentId === undefined
    ? (await readdir(path.join(stateRoot, "assignments"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [assignmentId];
  const plans = await Promise.all(assignmentIds.map((candidate) => planAssignmentArchive({
    stateRoot,
    assignmentId: candidate,
    ...(candidate === assignmentId && typeof input.batchId === "string" ? { batchId: input.batchId } : {}),
    retentionDays: effective.config.retention.closedAssignmentsDays,
  })));
  if (mode === "dry-run") return { mode, plans };
  const results = [];
  for (const plan of plans) {
    if (!plan.eligible) continue;
    results.push(await durableMaintenance(stateRoot, plan.operation_id, () => applyAssignmentArchive({ stateRoot, plan }), effective.config.intentLogging.retryCount, effective.config.intentLogging.backoffSeconds));
  }
  return { mode, plans, results };
}

async function cleanupCommand(root: string, mode: "dry-run" | "apply") {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const { stateRoot } = await initializeStateRoot(root, effective.config.state.directory);
  const operationId = `cleanup-${randomUUID()}`;
  const plan = await planRawResponseCleanup({ stateRoot, operationId, mode, retentionDays: effective.config.retention.rawResponsesDays });
  const installationTransactions = await planInstallationTransactionCleanup(root, effective.config.state.directory, effective.config.retention.installationBackupsDays);
  if (mode === "dry-run") return { ...plan, installation_transactions: installationTransactions };
  const rawResponses = await durableMaintenance(stateRoot, operationId, () => applyRawResponseCleanup(stateRoot, plan), effective.config.intentLogging.retryCount, effective.config.intentLogging.backoffSeconds);
  const installationTransactionsRemoved = await pruneInstallationTransactions(root, effective.config.state.directory, effective.config.retention.installationBackupsDays);
  return { ...rawResponses, installationTransactionsRemoved };
}

async function jiraDoctorCommand(root: string) {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const configuration = effective.config.integrations.jira;
  const health = await jiraConfigurationHealthAsync(configuration);
  const issueKey = option("issue");
  if (!issueKey || !configuration.enabled || !configuration.siteUrl) {
    return {
      integration: health,
      ...(issueKey && !configuration.enabled ? { inspection: { status: "not_run", reason: "JIRA_INTEGRATION_DISABLED" } } : {}),
      nextStep: !configuration.enabled ? "Enable and configure integrations.jira to inspect Jira workflow mappings." : !issueKey ? "Optionally run `orbitkeep jira doctor --issue PROJECT-123` to validate its current direct transitions." : "Configure a Jira site URL and credential reference before inspection.",
    };
  }
  const credential = await resolveJiraCredentialAsync(configuration.credentialReference);
  if (!credential.available || !credential.authorization) {
    return { integration: health, inspection: { status: "not_run", reason: credential.code }, nextStep: "Set the configured Jira credential environment variable, then rerun this command." };
  }
  if (!issueKey) return { integration: health, connection: { status: "ready_for_read_only_probe" }, nextStep: "Run `orbitkeep jira doctor --issue PROJECT-123` to fetch the current issue and its legal direct transitions." };
  const adapter = new JiraCloudReadClient({ siteUrl: configuration.siteUrl, authorization: credential.authorization });
  const inspection = await inspectJiraWorkflow({ configuration, adapter, issueKey });
  return { integration: health, inspection: { status: "completed", ...inspection }, nextStep: "This inspection performed read-only Jira requests; review proposed or pending outcomes before enabling any governed writes." };
}

async function promptText(label: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(label)).trim(); } finally { prompt.close(); }
}

function providerProgress(event: HeadlessProviderEvent): void {
  if (activeOutputMode !== "human") return;
  if (event.kind === "tool_started") process.stdout.write(`  → ${event.sourceType}\n`);
  else if (event.kind === "tool_completed") process.stdout.write(`  ✓ ${event.sourceType}\n`);
  else if (event.kind === "error") process.stdout.write(`  ! ${event.sourceType}\n`);
}

async function missionStart(root: string, input: Input): Promise<unknown> {
  const providerValue = input.provider ?? option("provider");
  if (providerValue !== "claude" && providerValue !== "codex") {
    throw Object.assign(new Error("Choose a headless provider with --provider claude or --provider codex."), { code: "MISSION_PROVIDER_REQUIRED" });
  }
  const provider = providerValue as SessionProvider;
  const objectiveValue = input.objective ?? option("objective");
  const objective = typeof objectiveValue === "string" && objectiveValue.trim()
    ? objectiveValue.trim()
    : process.stdin.isTTY ? await promptText("Mission objective: ") : "";
  if (!objective) throw Object.assign(new Error("A Mission objective is required."), { code: "MISSION_OBJECTIVE_REQUIRED" });

  const current = await service(root);
  const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  if (await resolveBrokeredSession(stateRoot, process.env)) {
    throw Object.assign(new Error("Mission commands must run in the Orbitkeep parent control channel, not inside a managed provider process."), { code: "MISSION_PARENT_CONTROL_REQUIRED" });
  }
  if (activeOutputMode === "human") process.stdout.write(`\nPlanning Mission with ${provider}…\n`);
  const planning = await runHeadlessProvider({ stateRoot, projectRoot: root, provider, phase: "plan", prompt: flightPlanPrompt(objective), onEvent: providerProgress });
  const generated = parseGeneratedFlightPlan(planning.finalMessage);
  await persistRedactedRawResponse(stateRoot, {
    responseId: `raw-${randomUUID()}`, provider, sourceEvent: "mission.plan.generated",
    content: { final_message: planning.finalMessage, event_count: planning.events.length, stderr: planning.stderr },
    retentionDays: current.effective.config.retention.rawResponsesDays,
  });
  const started = await managerCommand(root, "start", {
    objective, approach: generated.approach, acceptanceCriteria: generated.acceptanceCriteria,
    managerInstanceId: planning.controlSession.manager_instance_id,
    actorId: planning.controlSession.manager_instance_id, actorType: "manager",
  }) as Awaited<ReturnType<WorkflowCommandService["start"]>>;
  const assignment = started.assignment;
  const approval = assignment.approvals.at(-1);
  const safePlan = { planId: assignment.currentPlan.planId, revision: assignment.currentPlan.revision, approach: assignment.currentPlan.approach, acceptanceCriteria: assignment.currentPlan.acceptanceCriteria };
  const awaiting = {
    status: "awaiting_approval", code: "APPROVAL_REQUIRED",
    mission: { assignmentId: assignment.assignmentId, objective: assignment.objective, lifecycle: assignment.lifecycle },
    plan: safePlan,
    approval: approval ? { approvalId: approval.approvalId, mode: current.effective.config.security.executiveApproval.mode } : undefined,
    provider: { name: provider, sessionId: planning.providerSessionId, planningEvents: planning.events.length },
    nextStep: "Approve or reject the Flight Plan in Orbitkeep before execution begins.",
  };
  if (assignment.executionAuthority.state !== "authorized" && !approval) throw Object.assign(new Error("Mission requires approval but no approval record was created."), { code: "APPROVAL_RECORD_MISSING" });
  const explicitApproval = process.argv.includes("--approve");
  const explicitRejection = process.argv.includes("--reject");
  if (explicitApproval && explicitRejection) throw Object.assign(new Error("Choose only one Flight Plan decision: --approve or --reject."), { code: "MISSION_DECISION_CONFLICT" });
  if (assignment.executionAuthority.state !== "authorized" && activeOutputMode !== "human" && !explicitApproval && !explicitRejection) return awaiting;
  if (assignment.executionAuthority.state !== "authorized" && activeOutputMode === "human") {
    process.stdout.write("\nFlight Plan\n");
    for (const [index, item] of generated.approach.entries()) process.stdout.write(`  ${index + 1}. ${item}\n`);
    process.stdout.write("\nAcceptance criteria\n");
    for (const item of generated.acceptanceCriteria) process.stdout.write(`  - ${item}\n`);
  }
  const decision = assignment.executionAuthority.state === "authorized"
    ? "approve"
    : explicitApproval ? "approve"
      : explicitRejection ? "reject"
        : (await promptText("\nFlight Plan decision — [a]pprove, [r]eject, or [l]ater: ")).toLowerCase();
  if (!["a", "approve", "r", "reject"].includes(decision)) return awaiting;
  const approvalDecision = decision === "r" || decision === "reject" ? "reject" : "approve";
  if (assignment.executionAuthority.state !== "authorized" && current.effective.config.security.executiveApproval.mode === "signed_ed25519") {
    return { ...awaiting, code: "SIGNED_APPROVAL_REQUIRED", decision: approvalDecision, nextStep: `Submit a signed Executive ${approvalDecision} receipt through the configured approval channel.` };
  }
  const refreshed = await managerCommand(root, "ownership-acquire", { assignmentId: assignment.assignmentId, managerInstanceId: assignment.managerInstanceId, actorId: assignment.managerInstanceId, actorType: "manager" }) as CommandResponse;
  const token = refreshed.assignment.ownershipLease?.token;
  if (!token) throw Object.assign(new Error("Mission ownership lease was not created."), { code: "OWNERSHIP_REQUIRED" });
  if (approvalDecision === "reject") {
    const reasonValue = input.reason ?? option("reason");
    const reason = typeof reasonValue === "string" && reasonValue.trim()
      ? reasonValue.trim()
      : process.stdin.isTTY ? await promptText("Rejection reason: ") : "";
    if (!reason) throw Object.assign(new Error("A reason is required to reject a Flight Plan."), { code: "MISSION_REJECTION_REASON_REQUIRED" });
    const rejected = await managerCommand(root, "reject-plan", {
      assignmentId: assignment.assignmentId, approvalId: approval!.approvalId,
      managerInstanceId: assignment.managerInstanceId, ownershipToken: token, reason,
      actorType: "executive", actorId: String(input.executiveId ?? "executive:local"),
    }) as Awaited<ReturnType<WorkflowCommandService["rejectPlan"]>>;
    return { status: "rejected", code: rejected.code, mission: { assignmentId: rejected.assignment.assignmentId, objective, lifecycle: rejected.assignment.lifecycle }, plan: safePlan, reason };
  }
  const approved = assignment.executionAuthority.state === "authorized" ? started : await managerCommand(root, "approve-plan", {
    assignmentId: assignment.assignmentId, approvalId: approval!.approvalId,
    managerInstanceId: assignment.managerInstanceId, ownershipToken: token,
    actorType: "executive", actorId: String(input.executiveId ?? "executive:local"),
  }) as Awaited<ReturnType<WorkflowCommandService["approvePlan"]>>;
  if (activeOutputMode === "human") process.stdout.write(`\n✓ Flight Plan approved. Launching ${provider} in the background…\n`);
  const ownershipToken = approved.assignment.ownershipLease?.token ?? token;
  const run = await prepareMissionRun(current, approved.assignment, ownershipToken, root);
  let job;
  try {
    job = await launchSupervisorJob(stateRoot, {
      action: "launch", projectRoot: root, provider,
      prompt: missionExecutionPrompt({ objective, ...generated }),
      managerInstanceId: approved.assignment.managerInstanceId,
      assignmentId: approved.assignment.assignmentId, taskId: run.taskId, executionId: run.executionId,
      ownershipToken,
      sourceEvent: "mission.execution.response", retentionDays: current.effective.config.retention.rawResponsesDays, idleTimeoutMs: current.effective.config.supervisor.idleTimeoutSeconds * 1_000,
    });
  } catch (error) {
    await failPreparedMissionRun(current, approved.assignment, ownershipToken, run.executionId, root);
    throw error;
  }
  return {
    status: "running", code: "MISSION_RUNNING_IN_BACKGROUND",
    mission: { assignmentId: approved.assignment.assignmentId, objective, lifecycle: approved.assignment.lifecycle },
    plan: safePlan,
    provider: { name: provider }, job: { id: job.job_id, state: job.state },
    nextStep: "The Mission continues if this terminal closes. Use `orbitkeep mission status` or `orbitkeep mission logs` to reconnect.",
  };
}

function missionProvider(input: Input): SessionProvider {
  const value = input.provider ?? option("provider");
  if (value !== "claude" && value !== "codex") throw Object.assign(new Error("Choose a provider with --provider claude or --provider codex."), { code: "MISSION_PROVIDER_REQUIRED" });
  return value;
}

function missionProjection(assignment: Awaited<ReturnType<StateWorkflowRepository["get"]>>) {
  if (!assignment) return undefined;
  return {
    missionId: assignment.assignmentId,
    objective: assignment.objective,
    lifecycle: assignment.lifecycle,
    commandAuthority: assignment.executionAuthority.state,
    plan: { revision: assignment.currentPlan.revision, purpose: assignment.currentPlan.purpose, lifecycle: assignment.currentPlan.lifecycle },
    operations: {
      total: assignment.tasks.length,
      active: assignment.tasks.filter((task) => ["dispatched", "running", "blocked", "result_submitted", "rework"].includes(task.state)).length,
      completed: assignment.tasks.filter((task) => ["accepted", "closed", "skipped"].includes(task.state)).length,
    },
    pendingActions: assignment.pendingActionIds.length,
    holds: assignment.holds,
    updatedAt: assignment.executionAuthority.updatedAt,
  };
}

async function missionContext(root: string, input: Input, command: string) {
  const provider = missionProvider(input);
  const current = await service(root);
  const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  if (await resolveBrokeredSession(stateRoot, process.env)) throw Object.assign(new Error("Mission commands must run in the Orbitkeep parent control channel."), { code: "MISSION_PARENT_CONTROL_REQUIRED" });
  const managerInstanceId = await getProviderManagerIdentity(stateRoot, provider);
  const explicit = input.assignmentId ?? input.missionId ?? option("mission");
  let assignmentId: string;
  try {
    assignmentId = await resolveAssignmentReference({ repository: current.repository, command, managerInstanceId, ...(typeof explicit === "string" ? { assignmentId: explicit } : {}) });
  } catch (error) {
    if (!(error instanceof AssignmentSelectionError) || error.code !== "ASSIGNMENT_SELECTION_REQUIRED" || activeOutputMode !== "human" || !process.stdin.isTTY) throw error;
    process.stdout.write("\nChoose a Mission\n");
    for (const [index, candidate] of error.candidates.entries()) process.stdout.write(`  ${index + 1}. ${candidate.objective} — ${candidate.lifecycle}\n`);
    const selected = Number(await promptText("Mission number: "));
    if (!Number.isInteger(selected) || selected < 1 || selected > error.candidates.length) throw Object.assign(new Error("A valid Mission number is required."), { code: "MISSION_SELECTION_INVALID" });
    assignmentId = error.candidates[selected - 1]!.assignmentId;
  }
  const assignment = await current.repository.get(assignmentId);
  if (!assignment) throw Object.assign(new Error("Mission was not found."), { code: "ASSIGNMENT_CONTEXT_NOT_FOUND" });
  return { provider, current, stateRoot, managerInstanceId, assignmentId, assignment };
}

async function recoverMissionOwnership(root: string, selected: Awaited<ReturnType<typeof missionContext>>): Promise<string> {
  const ownership = await managerCommand(root, "ownership-acquire", { assignmentId: selected.assignmentId, managerInstanceId: selected.managerInstanceId, actorId: selected.managerInstanceId, actorType: "manager" }) as CommandResponse;
  const token = ownership.assignment.ownershipLease?.token;
  if (!token) throw Object.assign(new Error("Mission ownership could not be recovered."), { code: "OWNERSHIP_REQUIRED" });
  return token;
}

async function decideMissionPlan(root: string, selected: Awaited<ReturnType<typeof missionContext>>, response: CommandResponse, input: Input): Promise<{ authorized?: CommandResponse; terminal?: unknown }> {
  if (response.assignment.executionAuthority.state === "authorized") return { authorized: response };
  const approval = [...response.assignment.approvals].reverse().find((candidate) => candidate.state === "requested" && candidate.subjectId === response.assignment.currentPlan.planId && candidate.subjectRevision === response.assignment.currentPlan.revision);
  if (!approval) throw Object.assign(new Error("Mission requires approval but no current approval record exists."), { code: "APPROVAL_RECORD_MISSING" });
  const awaiting = {
    status: "awaiting_approval", code: "APPROVAL_REQUIRED", mission: missionProjection(response.assignment),
    plan: { revision: response.assignment.currentPlan.revision, approach: response.assignment.currentPlan.approach, acceptanceCriteria: response.assignment.currentPlan.acceptanceCriteria },
    approval: { mode: selected.current.effective.config.security.executiveApproval.mode },
    nextStep: "Approve, reject, or defer the Flight Plan in Orbitkeep.",
  };
  const approve = process.argv.includes("--approve"); const reject = process.argv.includes("--reject");
  if (approve && reject) throw Object.assign(new Error("Choose only one Flight Plan decision: --approve or --reject."), { code: "MISSION_DECISION_CONFLICT" });
  if (activeOutputMode !== "human" && !approve && !reject) return { terminal: awaiting };
  if (activeOutputMode === "human") {
    process.stdout.write(`\nFlight Plan revision ${response.assignment.currentPlan.revision}\n`);
    for (const [index, item] of response.assignment.currentPlan.approach.entries()) process.stdout.write(`  ${index + 1}. ${item}\n`);
    process.stdout.write("\nAcceptance criteria\n");
    for (const item of response.assignment.currentPlan.acceptanceCriteria) process.stdout.write(`  - ${item}\n`);
  }
  const answer = approve ? "approve" : reject ? "reject" : (await promptText("\nFlight Plan decision — [a]pprove, [r]eject, or [l]ater: ")).toLowerCase();
  if (!["a", "approve", "r", "reject"].includes(answer)) return { terminal: awaiting };
  const decision = answer === "r" || answer === "reject" ? "reject" : "approve";
  if (selected.current.effective.config.security.executiveApproval.mode === "signed_ed25519") return { terminal: { ...awaiting, code: "SIGNED_APPROVAL_REQUIRED", decision, nextStep: `Submit a signed Executive ${decision} receipt through the configured approval channel.` } };
  const token = await recoverMissionOwnership(root, selected);
  if (decision === "reject") {
    const reasonValue = input.reason ?? option("reason");
    const reason = typeof reasonValue === "string" && reasonValue.trim() ? reasonValue.trim() : process.stdin.isTTY ? await promptText("Rejection reason: ") : "";
    if (!reason) throw Object.assign(new Error("A reason is required to reject a Flight Plan."), { code: "MISSION_REJECTION_REASON_REQUIRED" });
    const rejected = await managerCommand(root, "reject-plan", { assignmentId: selected.assignmentId, approvalId: approval.approvalId, managerInstanceId: selected.managerInstanceId, ownershipToken: token, actorType: "executive", actorId: String(input.executiveId ?? "executive:local"), reason }) as CommandResponse;
    return { terminal: { status: "rejected", code: rejected.code, mission: missionProjection(rejected.assignment), reason } };
  }
  return { authorized: await managerCommand(root, "approve-plan", { assignmentId: selected.assignmentId, approvalId: approval.approvalId, managerInstanceId: selected.managerInstanceId, ownershipToken: token, actorType: "executive", actorId: String(input.executiveId ?? "executive:local") }) as CommandResponse };
}

async function executeExistingMission(root: string, selected: Awaited<ReturnType<typeof missionContext>>, assignment: CommandResponse["assignment"], sourceEvent: string): Promise<unknown> {
  const token = assignment.ownershipLease?.token ?? await recoverMissionOwnership(root, selected);
  if (activeOutputMode === "human") process.stdout.write(`\nLaunching Mission with ${selected.provider} in the background…\n`);
  const run = await prepareMissionRun(selected.current, assignment, token, root);
  let job;
  try {
    job = await launchSupervisorJob(selected.stateRoot, {
      action: "launch", projectRoot: root, provider: selected.provider,
      prompt: missionExecutionPrompt({ objective: assignment.objective, approach: assignment.currentPlan.approach, acceptanceCriteria: assignment.currentPlan.acceptanceCriteria }),
      managerInstanceId: selected.managerInstanceId, assignmentId: selected.assignmentId, taskId: run.taskId, executionId: run.executionId, ownershipToken: token,
      sourceEvent, retentionDays: selected.current.effective.config.retention.rawResponsesDays, idleTimeoutMs: selected.current.effective.config.supervisor.idleTimeoutSeconds * 1_000,
    });
  } catch (error) {
    await failPreparedMissionRun(selected.current, assignment, token, run.executionId, root);
    throw error;
  }
  return { status: "running", code: "MISSION_RUNNING_IN_BACKGROUND", mission: missionProjection(assignment), provider: { name: selected.provider }, job: { id: job.job_id, state: job.state }, nextStep: "Use `orbitkeep mission status` or `orbitkeep mission logs` to reconnect." };
}

async function missionStatus(root: string, input: Input): Promise<unknown> {
  const provider = missionProvider(input);
  const current = await service(root);
  const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  const managerInstanceId = await getProviderManagerIdentity(stateRoot, provider);
  const explicit = input.assignmentId ?? input.missionId ?? option("mission");
  if (typeof explicit === "string") {
    const assignment = await current.repository.get(explicit);
    if (!assignment || assignment.managerInstanceId !== managerInstanceId) throw Object.assign(new Error("Mission was not found for the selected provider."), { code: "ASSIGNMENT_CONTEXT_NOT_FOUND" });
    await managerCommand(root, "status", { assignmentId: explicit, managerInstanceId, actorId: "executive:local", actorType: "executive" });
    const refreshed = await current.repository.get(explicit) ?? assignment;
    const awaitingAcceptance = refreshed.tasks.some((task) => task.state === "result_submitted");
    return { status: "succeeded", provider, mission: missionProjection(refreshed), jobs: await supervisorJobs(stateRoot, explicit), ...(awaitingAcceptance ? { nextStep: "Review the Mission Report with `orbitkeep mission logs`, then run `orbitkeep mission accept`." } : {}) };
  }
  const assignments = (await current.repository.listAssignments?.() ?? []).filter((candidate) => candidate.managerInstanceId === managerInstanceId);
  const missions = (await Promise.all(assignments.map((candidate) => current.repository.get(candidate.assignmentId)))).filter(Boolean).map(missionProjection);
  const missionIds = new Set(assignments.map((candidate) => candidate.assignmentId));
  const jobs = (await supervisorJobs(stateRoot)).filter((job) => missionIds.has(job.assignment_id));
  const awaitingAcceptance = (await Promise.all(assignments.map((candidate) => current.repository.get(candidate.assignmentId)))).some((assignment) => assignment?.tasks.some((task) => task.state === "result_submitted"));
  return { status: "succeeded", provider, missions, jobs, nextStep: missions.length === 0 ? "Start a Mission with `orbitkeep mission start`." : awaitingAcceptance ? "A Mission Report is awaiting review. Use `orbitkeep mission logs`, then `orbitkeep mission accept`." : undefined };
}

async function missionList(root: string): Promise<unknown> {
  const current = await service(root);
  const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  const identities = new Map<string, SessionProvider>();
  for (const provider of ["claude", "codex"] as const) identities.set(await getProviderManagerIdentity(stateRoot, provider), provider);
  const assignments = await current.repository.listAssignments?.() ?? [];
  const missions = (await Promise.all(assignments.map(async (candidate) => {
    const assignment = await current.repository.get(candidate.assignmentId);
    return assignment ? { provider: identities.get(assignment.managerInstanceId) ?? "unknown", ...missionProjection(assignment) } : undefined;
  }))).filter(Boolean);
  return { status: "succeeded", missions, supervisor: await inspectSupervisor(stateRoot), nextStep: missions.length === 0 ? "Start a Mission with `npx orbitkeep mission start`." : undefined };
}

async function missionLogs(root: string, input: Input): Promise<unknown> {
  const selected = await missionContext(root, input, "status");
  const jobs = await supervisorJobs(selected.stateRoot, selected.assignmentId);
  const requested = input.jobId ?? option("job");
  const job = typeof requested === "string" ? jobs.find((candidate) => candidate.job_id === requested) : jobs[0];
  if (!job) return { status: "succeeded", code: "MISSION_LOGS_EMPTY", mission: missionProjection(selected.assignment), events: [] };
  const events = await readSupervisorEvents(selected.stateRoot, job.job_id);
  const final = [...events].reverse().map((event) => event !== null && typeof event === "object" ? event as Record<string, unknown> : {}).find((event) => event.kind === "final_response");
  return { status: "succeeded", code: "MISSION_LOGS_AVAILABLE", mission: missionProjection(selected.assignment), job, events, ...(typeof final?.final_message === "string" ? { result: final.final_message } : {}) };
}

async function missionAsk(root: string, input: Input): Promise<unknown> {
  const questionValue = input.question ?? option("question");
  const question = typeof questionValue === "string" && questionValue.trim() ? questionValue.trim() : process.stdin.isTTY ? await promptText("Question: ") : "";
  if (!question) throw Object.assign(new Error("A question is required."), { code: "MISSION_QUESTION_REQUIRED" });
  const selected = await missionContext(root, input, "ask");
  await managerCommand(root, "ask", { assignmentId: selected.assignmentId, managerInstanceId: selected.managerInstanceId, actorId: "executive:local", actorType: "executive", question });
  if (activeOutputMode === "human") process.stdout.write(`\nAsking ${selected.provider} about the Mission…\n`);
  const response = await runHeadlessProvider({
    stateRoot: selected.stateRoot, projectRoot: root, provider: selected.provider, phase: "plan",
    managerInstanceId: selected.managerInstanceId, assignmentId: selected.assignmentId,
    prompt: [
      "Answer this side question about an existing Orbitkeep Mission.",
      "Inspect repository content read-only if needed. Do not modify files or workflow state.",
      `Mission objective: ${selected.assignment.objective}`,
      `Current lifecycle: ${selected.assignment.lifecycle}`,
      `Current Flight Plan revision: ${selected.assignment.currentPlan.revision}`,
      `Question: ${question}`,
    ].join("\n"), onEvent: providerProgress,
  });
  await persistRedactedRawResponse(selected.stateRoot, {
    responseId: `raw-${randomUUID()}`, provider: selected.provider, sourceEvent: "mission.question.response",
    content: { question, final_message: response.finalMessage, event_count: response.events.length, stderr: response.stderr },
    retentionDays: selected.current.effective.config.retention.rawResponsesDays, assignmentId: selected.assignmentId,
  });
  return { status: "succeeded", code: "MISSION_QUESTION_ANSWERED", mission: missionProjection(selected.assignment), question, answer: response.finalMessage, provider: { name: selected.provider, sessionId: response.providerSessionId } };
}

async function missionPause(root: string, input: Input): Promise<unknown> {
  const selected = await missionContext(root, input, "pause");
  const modeValue = input.mode ?? option("mode") ?? "graceful";
  if (modeValue !== "graceful" && modeValue !== "force") throw Object.assign(new Error("Pause mode must be graceful or force."), { code: "MISSION_PAUSE_MODE_INVALID" });
  const timeoutMs = Number(input.timeoutMs ?? option("timeout-ms") ?? 5_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw Object.assign(new Error("Pause timeout must be a nonnegative integer."), { code: "MISSION_PAUSE_TIMEOUT_INVALID" });
  const token = await recoverMissionOwnership(root, selected);
  const controls = await interruptBrokeredSessions(selected.stateRoot, selected.assignmentId, modeValue, timeoutMs);
  if (controls.some((control) => !control.confirmed)) return { status: "blocked", code: "PAUSE_INCOMPLETE", mission: missionProjection(selected.assignment), controls };
  const paused = await managerCommand(root, "pause", { assignmentId: selected.assignmentId, managerInstanceId: selected.managerInstanceId, ownershipToken: token, actorId: selected.managerInstanceId, actorType: "manager", mode: modeValue, timeoutMs }) as Awaited<ReturnType<WorkflowCommandService["pause"]>>;
  return { status: paused.status, code: paused.code, mission: missionProjection(paused.assignment), controls };
}

async function missionStop(root: string, input: Input): Promise<unknown> {
  const selected = await missionContext(root, input, "cancel");
  const modeValue = process.argv.includes("--force") ? "force" : input.mode ?? option("mode") ?? "graceful";
  if (modeValue !== "graceful" && modeValue !== "force") throw Object.assign(new Error("Stop mode must be graceful or force."), { code: "MISSION_STOP_MODE_INVALID" });
  const timeoutMs = Number(input.timeoutMs ?? option("timeout-ms") ?? 5_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw Object.assign(new Error("Stop timeout must be a nonnegative integer."), { code: "MISSION_STOP_TIMEOUT_INVALID" });
  const token = await recoverMissionOwnership(root, selected);
  const controls = await interruptBrokeredSessions(selected.stateRoot, selected.assignmentId, modeValue, timeoutMs);
  if (controls.some((control) => !control.confirmed)) return { status: "blocked", code: "MISSION_STOP_INCOMPLETE", mission: missionProjection(selected.assignment), controls };
  const reconciliationDeadline = Date.now() + Math.max(timeoutMs + 5_000, 5_000);
  let activeJobs = true;
  while (Date.now() < reconciliationDeadline) {
    const jobs = await supervisorJobs(selected.stateRoot, selected.assignmentId);
    activeJobs = jobs.some((job) => ["queued", "starting", "running"].includes(job.state));
    if (!activeJobs) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (activeJobs) return { status: "blocked", code: "MISSION_STOP_RECONCILING", mission: missionProjection(selected.assignment), controls };
  const cancelled = await managerCommand(root, "cancel", { assignmentId: selected.assignmentId, managerInstanceId: selected.managerInstanceId, ownershipToken: token, actorId: selected.managerInstanceId, actorType: "manager" }) as CommandResponse;
  return { status: cancelled.status, code: cancelled.code, mission: missionProjection(cancelled.assignment), controls };
}

async function missionAccept(root: string, input: Input): Promise<unknown> {
  const selected = await missionContext(root, input, "accept");
  const token = await recoverMissionOwnership(root, selected);
  const current = await selected.current.repository.get(selected.assignmentId);
  if (!current) throw Object.assign(new Error("Mission was not found."), { code: "ASSIGNMENT_CONTEXT_NOT_FOUND" });
  const submitted = current.tasks.filter((task) => task.state === "result_submitted");
  if (submitted.length === 0) throw Object.assign(new Error("This Mission has no submitted result awaiting acceptance."), { code: "MISSION_RESULT_NOT_READY" });
  const ctx = { actor: { actorId: String(input.executiveId ?? "executive:local"), actorType: "executive" as const }, managerInstanceId: selected.managerInstanceId, ownershipToken: token };
  for (const task of submitted) {
    await selected.current.service.acceptResult(selected.assignmentId, task.taskId, ctx);
    await selected.current.service.closeTask(selected.assignmentId, task.taskId, ctx);
  }
  const closed = await selected.current.service.closeAssignment(selected.assignmentId, ctx);
  return { status: closed.status, code: closed.code, mission: missionProjection(closed.assignment), acceptedResults: submitted.flatMap((task) => task.resultIds) };
}

async function supervisorCommand(root: string, subcommand: string | undefined, input: Input): Promise<unknown> {
  const current = await service(root); const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  if (subcommand === "status") return { status: "succeeded", supervisor: await inspectSupervisor(stateRoot) };
  if (subcommand === "stop") {
    const timeoutMs = Number(input.timeoutMs ?? option("timeout-ms") ?? 5_000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw Object.assign(new Error("Supervisor stop timeout must be a nonnegative integer."), { code: "SUPERVISOR_STOP_TIMEOUT_INVALID" });
    return shutdownSupervisor(stateRoot, { force: process.argv.includes("--force"), timeoutMs });
  }
  throw new Error("Unknown supervisor command. Supported: supervisor status, supervisor stop [--force]");
}

async function missionResume(root: string, input: Input): Promise<unknown> {
  const selected = await missionContext(root, input, "resume");
  const token = await recoverMissionOwnership(root, selected);
  const resumed = await managerCommand(root, "resume", { assignmentId: selected.assignmentId, managerInstanceId: selected.managerInstanceId, ownershipToken: token, actorId: selected.managerInstanceId, actorType: "manager" }) as CommandResponse;
  const decision = await decideMissionPlan(root, selected, resumed, input);
  if (decision.terminal !== undefined) return decision.terminal;
  return executeExistingMission(root, selected, decision.authorized!.assignment, "mission.resume.response");
}

async function missionSteer(root: string, input: Input): Promise<unknown> {
  const instructionValue = input.instruction ?? input.rationale ?? option("instruction");
  const instruction = typeof instructionValue === "string" && instructionValue.trim() ? instructionValue.trim() : process.stdin.isTTY ? await promptText("Course correction: ") : "";
  if (!instruction) throw Object.assign(new Error("A course-correction instruction is required."), { code: "MISSION_STEER_INSTRUCTION_REQUIRED" });
  const selected = await missionContext(root, input, "steer");
  if (activeOutputMode === "human") process.stdout.write(`\nRevising the Flight Plan with ${selected.provider}…\n`);
  const planning = await runHeadlessProvider({
    stateRoot: selected.stateRoot, projectRoot: root, provider: selected.provider, phase: "plan", managerInstanceId: selected.managerInstanceId, assignmentId: selected.assignmentId,
    prompt: flightPlanPrompt(`Revise this existing Mission without beginning work. Current objective: ${selected.assignment.objective}. Executive course correction: ${instruction}`), onEvent: providerProgress,
  });
  const plan = parseGeneratedFlightPlan(planning.finalMessage);
  const paths = Array.isArray(input.paths) && input.paths.every((item) => typeof item === "string")
    ? input.paths as string[]
    : typeof option("paths") === "string" ? option("paths")!.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const token = await recoverMissionOwnership(root, selected);
  const steered = await managerCommand(root, "steer", { assignmentId: selected.assignmentId, managerInstanceId: selected.managerInstanceId, ownershipToken: token, actorId: selected.managerInstanceId, actorType: "manager", paths, rationale: instruction, approach: plan.approach, acceptanceCriteria: plan.acceptanceCriteria }) as CommandResponse;
  const decision = await decideMissionPlan(root, selected, steered, input);
  if (decision.terminal !== undefined) return decision.terminal;
  return executeExistingMission(root, selected, decision.authorized!.assignment, "mission.steer.response");
}

async function missionHandover(root: string, input: Input): Promise<unknown> {
  const selected = await missionContext(root, input, "handover");
  const targetValue = input.toProvider ?? option("to");
  if (targetValue !== "claude" && targetValue !== "codex") throw Object.assign(new Error("Choose the receiving provider with --to claude or --to codex."), { code: "MISSION_HANDOVER_PROVIDER_REQUIRED" });
  if (targetValue === selected.provider) throw Object.assign(new Error("The receiving provider must differ from the current provider."), { code: "MISSION_HANDOVER_PROVIDER_UNCHANGED" });
  const modeValue = input.mode ?? option("mode") ?? "graceful";
  if (modeValue !== "graceful" && modeValue !== "force") throw Object.assign(new Error("Handover mode must be graceful or force."), { code: "MISSION_HANDOVER_MODE_INVALID" });
  const timeoutMs = Number(input.timeoutMs ?? option("timeout-ms") ?? 5_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw Object.assign(new Error("Handover timeout must be a nonnegative integer."), { code: "MISSION_HANDOVER_TIMEOUT_INVALID" });
  const token = await recoverMissionOwnership(root, selected);
  const controls = await interruptBrokeredSessions(selected.stateRoot, selected.assignmentId, modeValue, timeoutMs);
  if (controls.some((control) => !control.confirmed)) return { status: "blocked", code: "HANDOVER_INCOMPLETE", mission: missionProjection(selected.assignment), controls };
  const receiverManagerInstanceId = await getProviderManagerIdentity(selected.stateRoot, targetValue);
  await acknowledgeHandover(selected.stateRoot, selected.assignmentId, receiverManagerInstanceId);
  const handed = await managerCommand(root, "handover", {
    assignmentId: selected.assignmentId, managerInstanceId: selected.managerInstanceId, ownershipToken: token,
    actorId: selected.managerInstanceId, actorType: "manager", receiverManagerInstanceId, mode: modeValue, timeoutMs,
  }) as CommandResponse<{ packageId?: string }>;
  return { status: handed.status, code: handed.code, mission: missionProjection(handed.assignment), fromProvider: selected.provider, toProvider: targetValue, packageId: handed.data?.packageId, controls };
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw Object.assign(new Error("Jira setup requires an interactive terminal so the API token can be entered privately."), { code: "JIRA_INTERACTIVE_TTY_REQUIRED" });
  process.stdout.write(label);
  const stream = process.stdin;
  stream.setRawMode?.(true); stream.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      stream.off("data", onData); stream.setRawMode?.(false); process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(Object.assign(new Error("Jira setup cancelled."), { code: "JIRA_SETUP_CANCELLED" }));
        if (byte === 13 || byte === 10) return finish();
        if (byte === 127 || byte === 8) { value = value.slice(0, -1); continue; }
        value += String.fromCharCode(byte);
      }
    };
    stream.on("data", onData);
  });
}

function stringRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function writeProjectConfiguration(root: string, value: unknown): Promise<void> {
  const target = path.join(root, ".agent-workflow", "config.json");
  const temporary = `${target}.orbitkeep-${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
  await rename(temporary, target);
}

/** Stores the token in the OS keychain first, verifies it read-only, then atomically records only its reference in project config. */
async function jiraConfigureCommand(root: string) {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) throw Object.assign(new Error("Jira setup requires an interactive terminal and does not accept API tokens through JSON or command-line options."), { code: "JIRA_INTERACTIVE_TTY_REQUIRED" });
  const siteUrl = option("site-url") ?? await promptText("Jira site URL (for example https://company.atlassian.net): ");
  const projectKey = option("project-key") ?? await promptText("Default Jira project key: ");
  const email = option("email") ?? await promptText("Atlassian account email: ");
  const token = await promptSecret("Jira API token (hidden): ");
  if (!siteUrl || !projectKey || !email || !token) throw Object.assign(new Error("Jira setup requires a site URL, project key, email, and API token."), { code: "JIRA_SETUP_INPUT_REQUIRED" });
  const reference = jiraKeychainReference(siteUrl);
  const authorization = `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
  const store = new SystemJiraSecretStore();
  await store.put(reference, authorization);
  try {
    const verified = await new JiraCloudReadClient({ siteUrl, authorization }).getCurrentUser();
    const configPath = path.join(root, ".agent-workflow", "config.json");
    const existing = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const rootConfig = stringRecord(existing); const integrations = stringRecord(rootConfig.integrations); const jira = stringRecord(integrations.jira);
    const existingProjects = Array.isArray(jira.projectKeys) ? jira.projectKeys.filter((value): value is string => typeof value === "string") : [];
    await writeProjectConfiguration(root, {
      ...rootConfig,
      integrations: {
        ...integrations,
        jira: {
          ...jira,
          enabled: true,
          mode: jira.mode === "automatic" || jira.mode === "propose" ? jira.mode : "observe",
          siteUrl,
          credentialReference: reference,
          projectKeys: [...new Set([...existingProjects, projectKey])].sort(),
        },
      },
    });
    return { status: "configured", siteUrl, projectKeys: [...new Set([...existingProjects, projectKey])].sort(), credentialStore: store.platform, credentialReference: reference, verification: { status: "succeeded", accountId: verified.accountId }, nextStep: `Run \`orbitkeep jira doctor --issue ${projectKey}-123\` to inspect a real issue's workflow without making changes.` };
  } catch (error) {
    await store.remove(reference).catch(() => undefined);
    throw error;
  }
}

async function configuredJiraClient(root: string) {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const configuration = effective.config.integrations.jira;
  if (!configuration.enabled || !configuration.siteUrl) throw Object.assign(new Error("Configure Jira first with `orbitkeep jira configure`."), { code: "JIRA_NOT_CONFIGURED" });
  const credential = await resolveJiraCredentialAsync(configuration.credentialReference);
  if (!credential.authorization) throw Object.assign(new Error("The configured Jira credential is unavailable. Run `orbitkeep jira configure` or restore its secret-store entry."), { code: credential.code ?? "JIRA_CREDENTIAL_UNAVAILABLE" });
  return { configuration, client: new JiraCloudReadClient({ siteUrl: configuration.siteUrl, authorization: credential.authorization }) };
}

async function jiraWorkflowSetupCommand(root: string) {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) throw Object.assign(new Error("Jira workflow setup requires an interactive terminal."), { code: "JIRA_INTERACTIVE_TTY_REQUIRED" });
  const issueKey = option("issue") ?? await promptText("Representative Jira issue key: ");
  const intentValue = option("intent") ?? await promptText(`Intent (${JIRA_WORK_INTENTS.join(", ")}): `);
  if (!JIRA_WORK_INTENTS.includes(intentValue as JiraWorkIntent)) throw Object.assign(new Error("Choose a supported Jira work intent."), { code: "JIRA_WORK_INTENT_INVALID" });
  const { configuration, client } = await configuredJiraClient(root);
  const [issue, transitions] = await Promise.all([client.getIssue(issueKey), client.getAvailableTransitions(issueKey)]);
  if (!configuration.projectKeys.some((key) => key.toLowerCase() === issue.projectKey.toLowerCase())) throw Object.assign(new Error(`Issue ${issue.issueKey} is outside integrations.jira.projectKeys.`), { code: "JIRA_PROJECT_NOT_ALLOWED" });
  if (transitions.length === 0) throw Object.assign(new Error("Jira reports no legal direct transitions for this issue. Choose another representative issue or configure a comment-only fallback."), { code: "JIRA_NO_TRANSITIONS_AVAILABLE" });
  process.stdout.write(`\n${issue.issueKey}: ${issue.issueType}, currently ${issue.status}\nAvailable direct transitions:\n${transitions.map((transition, index) => `  ${index + 1}. ${transition.name} → ${transition.toStatus}${transition.requiredFields?.length ? ` (requires ${transition.requiredFields.join(", ")})` : ""}`).join("\n")}\n\n`);
  const selectedText = await promptText("Choose a transition number (blank to configure a no-transition fallback): ");
  const selection = selectedText === "" ? undefined : transitions[Number(selectedText) - 1];
  if (selectedText !== "" && !selection) throw Object.assign(new Error("Transition selection is invalid."), { code: "JIRA_TRANSITION_SELECTION_INVALID" });
  const authorityValue = option("authority") ?? await promptText(`Authority (${JIRA_ACTION_AUTHORITIES.join(", ")}; default automatic): `);
  const authority = (authorityValue || "automatic") as JiraActionAuthority;
  if (!JIRA_ACTION_AUTHORITIES.includes(authority)) throw Object.assign(new Error("Jira mapping authority is invalid."), { code: "JIRA_MAPPING_AUTHORITY_INVALID" });
  const fallbackValue = option("fallback") ?? await promptText(`Fallback (${JIRA_TRANSITION_FALLBACKS.join(", ")}; default pending): `);
  const fallback = (fallbackValue || "pending") as JiraTransitionFallback;
  if (!JIRA_TRANSITION_FALLBACKS.includes(fallback)) throw Object.assign(new Error("Jira mapping fallback is invalid."), { code: "JIRA_MAPPING_FALLBACK_INVALID" });
  const profileId = `jira-${issue.projectKey.toLowerCase()}-${issue.issueType.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const targetProfile = configuration.workflowProfiles.find((profile) => profile.projectKey.toLowerCase() === issue.projectKey.toLowerCase() && profile.issueTypes.some((entry) => entry.toLowerCase() === issue.issueType.toLowerCase()));
  const profile: JiraWorkflowProfile = targetProfile ?? { id: profileId, projectKey: issue.projectKey, issueTypes: [issue.issueType], mappings: {} };
  const updatedProfile: JiraWorkflowProfile = { ...profile, mappings: { ...profile.mappings, [intentValue]: { ...(selection === undefined ? {} : { targetStatus: selection.toStatus }), authority, fallback } } };
  const profiles = [...configuration.workflowProfiles.filter((candidate) => candidate !== targetProfile), updatedProfile].sort((left, right) => left.id.localeCompare(right.id));
  const configPath = path.join(root, ".agent-workflow", "config.json"); const existing = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const rootConfig = stringRecord(existing); const integrations = stringRecord(rootConfig.integrations); const jira = stringRecord(integrations.jira);
  await writeProjectConfiguration(root, { ...rootConfig, integrations: { ...integrations, jira: { ...jira, workflowProfiles: profiles } } });
  return { status: "workflow_mapping_configured", issue: { issueKey: issue.issueKey, projectKey: issue.projectKey, issueType: issue.issueType, currentStatus: issue.status }, profileId: updatedProfile.id, intent: intentValue, mapping: updatedProfile.mappings[intentValue as JiraWorkIntent], nextStep: authority === "automatic" ? "The mapping remains observational until `orbitkeep jira enable-writes` is explicitly confirmed." : "Run `orbitkeep jira doctor --issue ISSUE-KEY` to review the mapping." };
}

async function jiraEnableWritesCommand(root: string) {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) throw Object.assign(new Error("Enabling Jira writes requires an interactive terminal."), { code: "JIRA_INTERACTIVE_TTY_REQUIRED" });
  const { configuration } = await configuredJiraClient(root);
  const confirmation = await promptText("This permits only mappings marked automatic to make confirmed, direct Jira changes. Type ENABLE JIRA WRITES to continue: ");
  if (confirmation !== "ENABLE JIRA WRITES") throw Object.assign(new Error("Jira write enablement was not confirmed."), { code: "JIRA_WRITES_NOT_CONFIRMED" });
  const configPath = path.join(root, ".agent-workflow", "config.json"); const existing = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  const rootConfig = stringRecord(existing); const integrations = stringRecord(rootConfig.integrations); const jira = stringRecord(integrations.jira);
  await writeProjectConfiguration(root, { ...rootConfig, integrations: { ...integrations, jira: { ...jira, enabled: true, mode: "automatic", projectKeys: configuration.projectKeys } } });
  return { status: "writes_enabled", mode: "automatic", mappedAutomaticIntents: configuration.workflowProfiles.flatMap((profile) => Object.entries(profile.mappings).filter(([, mapping]) => mapping?.authority === "automatic").map(([intent]) => ({ profileId: profile.id, intent }))), nextStep: "Use the governed Jira intent executor from a managed integration handler; it will still refuse unallowlisted projects, non-direct transitions, missing required fields, and unconfirmed writes." };
}

/** A manager-facing bridge: records a canonical Action before and after every Jira intent attempt. */
async function jiraSyncCommand(root: string, input: Input) {
  const assignmentId = required(input, "assignmentId"); const taskId = required(input, "taskId"); const issueKey = required(input, "issueKey");
  const intent = required(input, "intent") as JiraWorkIntent;
  if (!JIRA_WORK_INTENTS.includes(intent)) throw Object.assign(new Error("Jira intent is invalid."), { code: "JIRA_WORK_INTENT_INVALID" });
  const current = await service(root); const ctx = context(input);
  if (!ctx.ownershipToken) throw Object.assign(new Error("A current ownership token is required for Jira synchronization."), { code: "OWNERSHIP_REQUIRED" });
  await current.repository.validateOwnership?.(assignmentId, ctx.managerInstanceId, ctx.ownershipToken, new Date());
  const task = (await current.repository.get(assignmentId))?.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw Object.assign(new Error("Task not found for Jira synchronization."), { code: "TASK_NOT_FOUND" });
  const action = await current.service.createAction(assignmentId, `Jira ${intent} synchronization for ${issueKey}`, ctx, { taskId, ...(typeof input.executionId === "string" ? { executionId: input.executionId } : {}) });
  await current.service.recordActionOutcome(assignmentId, action.actionId, "started", ctx);
  try {
    const { configuration, client } = await configuredJiraClient(root);
    const outcome = await executeJiraIntent({ configuration, adapter: client, issueKey, intent, ...(input.fields && typeof input.fields === "object" && !Array.isArray(input.fields) ? { fields: input.fields as Record<string, unknown> } : {}), ...(typeof input.comment === "string" ? { comment: input.comment } : {}), idempotencyKey: action.actionId });
    const state = outcome.status === "transitioned" || outcome.status === "commented" ? "succeeded" : "prevented";
    await current.service.recordActionOutcome(assignmentId, action.actionId, state, ctx);
    return { status: outcome.status, actionId: action.actionId, assignmentId, taskId, issueKey, intent, jira: outcome };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const state = code === "JIRA_REQUEST_FAILED" || code === "JIRA_TRANSITION_UNCONFIRMED" ? "unknown" : "failed";
    await current.service.recordActionOutcome(assignmentId, action.actionId, state, ctx);
    throw error;
  }
}

async function bindJiraTaskCommand(root: string, input: Input) {
  const assignmentId = required(input, "assignmentId"); const taskId = required(input, "taskId"); const issueKey = required(input, "issueKey");
  const current = await service(root); const ctx = context(input);
  if (!ctx.ownershipToken) throw Object.assign(new Error("A current ownership token is required for Jira task binding."), { code: "OWNERSHIP_REQUIRED" });
  await current.repository.validateOwnership?.(assignmentId, ctx.managerInstanceId, ctx.ownershipToken, new Date());
  if (!(await current.repository.get(assignmentId))?.tasks.some((task) => task.taskId === taskId)) throw Object.assign(new Error("Task not found for Jira binding."), { code: "TASK_NOT_FOUND" });
  const { stateRoot } = await initializeStateRoot(root, current.effective.config.state.directory);
  const binding = await bindJiraTask({ stateRoot, assignmentId, taskId, issueKey });
  await appendEvent({ projectRoot: root, stateDirectory: current.effective.config.state.directory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: { schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: "provider.signal_observed", occurred_at: new Date().toISOString(), actor: { actor_id: ctx.actor.actorId, actor_type: ctx.actor.actorType }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, assignment_id: assignmentId, task_id: taskId, provider_context: { provider: "jira" }, data: { provider: "jira", signal: "binding.created", details: { binding_id: binding.bindingId, issue_key: binding.issueKey } } } });
  return { status: "bound", ...binding };
}

async function synchronizeBoundJiraTask(root: string, input: Input, taskId: string, intent: JiraWorkIntent): Promise<unknown | undefined> {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  if (!effective.config.integrations.jira.enabled) return undefined;
  const { stateRoot } = await initializeStateRoot(root, effective.config.state.directory);
  const binding = await jiraTaskBinding(stateRoot, taskId);
  if (!binding) return undefined;
  try { return await jiraSyncCommand(root, { ...input, assignmentId: binding.assignmentId, taskId, issueKey: binding.issueKey, intent }); }
  catch (error) { return { status: "sync_failed", code: (error as { code?: string }).code ?? "JIRA_SYNC_FAILED", message: error instanceof Error ? error.message : String(error) }; }
}

async function controlCommand(root: string, subcommand: string | undefined, input: Input) {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const { stateRoot } = await initializeStateRoot(root, effective.config.state.directory);
  if (subcommand === "status") {
    const record = await controlStatus(stateRoot, required(input, "executionId"), effective.config.retention.rawResponsesDays);
    if (!record) return { status: "not_registered" };
    if (record.response_capture && !record.response_capture.event_id) {
      const eventId = `evt-${randomUUID()}`;
      await appendEvent({
        projectRoot: root, stateDirectory: effective.config.state.directory, operationId: `op-${randomUUID()}`,
        validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event",
        event: {
          schema_version: "1.0", event_id: eventId, event_type: "provider.signal_observed", occurred_at: record.response_capture.captured_at,
          actor: { actor_id: `provider:${record.provider}`, actor_type: "external_system" },
          recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" },
          assignment_id: record.assignment_id,
          ...(record.task_id ? { task_id: record.task_id } : {}), execution_id: record.execution_id,
          provider_context: { provider: record.provider },
          data: { provider: record.provider, signal: "response.captured", details: { response_id: record.response_capture.response_id, truncated: record.response_capture.truncated } },
        },
      });
      await markResponseCaptureObserved(stateRoot, record.execution_id, eventId);
      record.response_capture.event_id = eventId;
    }
    return record;
  }
  if (subcommand === "acknowledge-handover") return acknowledgeHandover(stateRoot, required(input, "assignmentId"), required(input, "receiverManagerInstanceId"));
  if (subcommand !== "launch") throw new Error("Unknown control command. Supported: control launch, control status, control acknowledge-handover");
  const provider = required(input, "provider");
  if (provider !== "codex" && provider !== "claude") throw new Error("CONTROL_PROVIDER_INVALID: provider must be codex or claude");
  if (!Array.isArray(input.args) || !input.args.every((value) => typeof value === "string")) throw new Error("CONTROL_ARGS_INVALID: args must be an array of strings");
  const managerInstanceId = required(input, "managerInstanceId"); const ownershipToken = required(input, "ownershipToken");
  const current = await service(root); await current.repository.validateOwnership?.(required(input, "assignmentId"), managerInstanceId, ownershipToken, new Date());
  return launchControlledCli(stateRoot, { provider, assignmentId: required(input, "assignmentId"), executionId: required(input, "executionId"), ...(typeof input.taskId === "string" ? { taskId: input.taskId } : {}), args: input.args as string[], managerInstanceId, ownershipToken, retentionDays: effective.config.retention.rawResponsesDays });
}

async function appendProviderSignal(root: string, provider: string, signal: NormalizedProviderSignal, stateDirectory: string) {
  return appendEvent({
    projectRoot: root, stateDirectory, operationId: `op-${randomUUID()}`,
    validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event",
    event: {
      schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: "provider.signal_observed", occurred_at: signal.occurredAt,
      actor: { actor_id: signal.actor.actorId, actor_type: signal.actor.actorType, ...(signal.actor.displayName ? { display_name: signal.actor.displayName } : {}) },
      recorded_by: { actor_id: signal.recordedBy.actorId, actor_type: signal.recordedBy.actorType, ...(signal.recordedBy.displayName ? { display_name: signal.recordedBy.displayName } : {}) },
      ...(signal.frameworkRefs.assignmentId ? { assignment_id: signal.frameworkRefs.assignmentId } : {}),
      ...(signal.frameworkRefs.taskId ? { task_id: signal.frameworkRefs.taskId } : {}),
      ...(signal.frameworkRefs.executionId ? { execution_id: signal.frameworkRefs.executionId } : {}),
      ...(signal.frameworkRefs.actionId ? { action_id: signal.frameworkRefs.actionId } : {}),
      provider_context: { provider, ...(signal.providerContext.providerSessionId ? { session_id: signal.providerContext.providerSessionId } : {}), ...(signal.providerContext.providerProcessId ? { process_id: signal.providerContext.providerProcessId } : {}), ...(signal.providerContext.providerTaskId ? { task_id: signal.providerContext.providerTaskId } : {}) },
      data: { provider, signal: signal.signalType, details: signal.data as unknown as JsonValue },
    },
  });
}

/**
 * Claude's PreToolUse hook is a policy boundary, not merely an audit tap. A
 * managed provider process must identify the active assignment/execution and
 * present the current manager fencing token. This deliberately denies an
 * uncorrelated interactive Claude session rather than letting it self-assert
 * that it is working for a workflow assignment.
 */
async function authorizeClaudePreTool(root: string, input: Input, signal: NormalizedProviderSignal, session: BrokeredSessionRecord | undefined): Promise<{ accepted: boolean; reason?: string }> {
  if (!session || session.provider !== "claude") {
    return { accepted: false, reason: "WORKFLOW_BROKER_SESSION_REQUIRED: start Claude through `npx orbitkeep mission start --provider claude`." };
  }
  if (session.kind === "planner") {
    return isBrokeredReadOnlyOperation(input, root)
      ? { accepted: true }
      : { accepted: false, reason: "WORKFLOW_PLANNING_READ_ONLY: headless planning permits repository discovery but not commands or modifications." };
  }
  const assignmentId = signal.frameworkRefs.assignmentId;
  const executionId = signal.frameworkRefs.executionId;
  const managerInstanceId = signal.providerContext.managerInstanceId;
  const ownershipToken = input.ownership_token ?? input.ownershipToken;
  if (!assignmentId && isBrokeredBootstrapOperation(input, root)) return { accepted: true };
  if (!assignmentId && (input.tool_name ?? input.toolName) === "Bash") {
    return {
      accepted: false,
      reason: "WORKFLOW_BOOTSTRAP_COMMAND_REQUIRED: start or resume the Mission first with one direct `npx --no-install orbitkeep start|resume --json '<single JSON object>' --redact-output` command. Do not use a pipe, heredoc, redirection, shell variable, substitution, or manual lease command.",
    };
  }
  if (!assignmentId || !managerInstanceId || typeof ownershipToken !== "string" || ownershipToken.length === 0) {
    return { accepted: false, reason: "WORKFLOW_AUTHORIZATION_REQUIRED: assignment, manager identity, and ownership token are required." };
  }

  try {
    const current = await service(root);
    const assignment = await current.repository.get(assignmentId);
    if (!assignment) return { accepted: false, reason: "WORKFLOW_ASSIGNMENT_NOT_FOUND: managed assignment does not exist." };
    if (assignment.managerInstanceId !== managerInstanceId) return { accepted: false, reason: "WORKFLOW_OWNERSHIP_MISMATCH: manager does not own assignment." };
    if ((assignment.lifecycle !== "running" || assignment.executionAuthority.state !== "authorized") && isBrokeredBootstrapOperation(input, root)) {
      return { accepted: true };
    }
    if (isBrokeredManagementOperation(input)) return { accepted: true };
    if (assignment.lifecycle !== "running" || assignment.executionAuthority.state !== "authorized") {
      return { accepted: false, reason: "WORKFLOW_EXECUTION_NOT_AUTHORIZED: assignment is not authorized for provider tool use." };
    }
    if (executionId) {
      const execution = assignment.executions.find((candidate) => candidate.executionId === executionId);
      if (!execution || execution.state !== "running") {
        return { accepted: false, reason: "WORKFLOW_EXECUTION_NOT_RUNNING: provider tool use is not associated with a running execution." };
      }
    }
    await current.repository.validateOwnership?.(assignmentId, managerInstanceId, ownershipToken, new Date());
    return { accepted: true };
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function observeProvider(root: string, provider: string, input: Input) {
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  const { stateRoot } = await initializeStateRoot(root, effective.config.state.directory);
  const brokeredSession = await resolveBrokeredSession(stateRoot, process.env);
  const normalizedInput = {
    ...input,
    actor: input.actor ?? { actor_id: "manager:provider", actor_type: "manager" },
    ...(brokeredSession?.assignment_id ? { assignment_id: brokeredSession.assignment_id } : {}),
    ...(brokeredSession?.task_id ? { framework_task_id: brokeredSession.task_id } : {}),
    ...(brokeredSession?.execution_id ? { execution_id: brokeredSession.execution_id } : {}),
    ...(brokeredSession ? { manager_instance_id: brokeredSession.manager_instance_id } : {}),
    ...(brokeredSession?.ownership_token ? { ownership_token: brokeredSession.ownership_token } : {}),
  };
  let signal: NormalizedProviderSignal;
  let hookOutput: unknown;
  if (provider === "claude") {
    const claude = new ClaudeProviderAdapter({
      blockingPreToolHook: true,
      workflowAuthorizationConnected: true,
      captureRawResponses: effective.config.providers.claude?.captureRawResponses === true,
    });
    if (input.hook_event_name === "PreToolUse") {
      const decision = await claude.decidePreToolUse(normalizedInput, async (candidate) => {
        const authorization = await authorizeClaudePreTool(root, normalizedInput, candidate, brokeredSession);
        try {
          await appendProviderSignal(root, provider, candidate, effective.config.state.directory);
          return authorization;
        } catch (error) {
          return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
        }
      });
      signal = decision.signal;
      hookOutput = decision.output;
    } else signal = await claude.translateHook(normalizedInput);
  } else if (provider === "codex") signal = await new CodexProviderAdapter({ captureRawResponses: effective.config.providers.codex?.captureRawResponses === true }).translateEvent(normalizedInput);
  else throw new Error(`Unknown provider: ${provider}`);
  const acknowledgement = hookOutput === undefined
    ? await appendProviderSignal(root, provider, signal, effective.config.state.directory)
    : undefined;
  let rawResponsePath: string | undefined;
  if (signal.rawResponse !== undefined) {
    rawResponsePath = await persistRedactedRawResponse(stateRoot, {
      responseId: `raw-${randomUUID()}`,
      provider,
      sourceEvent: signal.sourceEvent,
      content: signal.rawResponse,
      retentionDays: effective.config.retention.rawResponsesDays,
      ...(signal.frameworkRefs.assignmentId ? { assignmentId: signal.frameworkRefs.assignmentId } : {}),
      ...(signal.frameworkRefs.taskId ? { taskId: signal.frameworkRefs.taskId } : {}),
      ...(signal.frameworkRefs.executionId ? { executionId: signal.frameworkRefs.executionId } : {}),
    });
  }
  if (hookOutput !== undefined) return hookOutput;
  return {
    accepted: true,
    classification: "observed",
    provider,
    signal: signal.signalType,
    acknowledgement,
    ...(rawResponsePath === undefined ? {} : { rawResponsePath }),
  };
}

export async function runCli(): Promise<void> {
  activeOutputMode = selectOutputMode({ argv: process.argv.slice(2), stdinIsTTY: process.stdin.isTTY, stdoutIsTTY: process.stdout.isTTY });
  assertSupportedRuntimeEnvironment();
  if (process.argv.includes("--version") || process.argv.includes("-V")) {
    activeCommand = "version";
    output({ version: FRAMEWORK_VERSION });
    return;
  }
  const [command, subcommand] = process.argv.slice(2).filter((value) => !value.startsWith("--") && value !== inlineJsonInput() && value !== option("project-root"));
  activeCommand = command ?? "help";
  if (!command || command === "help" || process.argv.includes("--help") || process.argv.includes("-h")) { output({ commands: [
    "setup", "init", "install --status|--recover|--rollback", "repair --plan|--apply", "doctor", "validate", "capabilities", "config show", "config validate", "upgrade --check|--plan|--apply|--status|--rollback", "--json|--verbose|--quiet", "--redact-output",
    "jira configure [--site-url URL] [--project-key KEY] [--email EMAIL]", "jira workflow-setup [--issue PROJECT-123] [--intent INTENT]", "jira enable-writes", "jira bind (manager JSON input)", "jira sync (manager JSON input)", "jira doctor [--issue PROJECT-123]",
    "cleanup --dry-run|--apply", "archive --dry-run|--apply",
    "mission start|list|status|logs|accept|ask|steer|pause|resume|stop|cancel|handover --provider claude|codex",
    "supervisor status|stop [--force]", "provider doctor --provider claude|codex",
    "silo status|derive",
  ] }); return; }
  const root = await findConsumerRoot(option("project-root") ?? process.cwd());
  if (command === "__supervisor" && subcommand === "shutdown") {
    const stateRoot = option("state-root");
    if (!stateRoot) throw Object.assign(new Error("Supervisor state root is required."), { code: "SUPERVISOR_STATE_ROOT_REQUIRED" });
    await shutdownSupervisor(stateRoot, { force: true }); return;
  }
  if (command === "__supervisor" && subcommand === "serve") {
    const stateRoot = option("state-root");
    if (!stateRoot) throw Object.assign(new Error("Supervisor state root is required."), { code: "SUPERVISOR_STATE_ROOT_REQUIRED" });
    const server = await serveSupervisor(stateRoot);
    await new Promise<void>((resolve) => server.once("close", resolve));
    return;
  }
  if (command === "setup") {
    const installation = await installConsumer(root);
    const health = await doctor(root);
    output({ status: health.activation === "active" ? "ready" : "attention_required", installation, health, nextStep: health.activation === "active" ? "Start a Mission with npx orbitkeep mission start." : "Review health.errors, then run npx orbitkeep repair --plan." });
    return;
  }
  if (command === "init") { output(await installConsumer(root)); return; }
  if (command === "install") {
    const stateDirectory = await installationStateDirectory(root); const input = await jsonInput();
    if (process.argv.includes("--status")) { output({ transactions: await listInstallationTransactions(root, stateDirectory) }); return; }
    if (process.argv.includes("--recover")) { output({ recovered: await recoverInterruptedTransactions(root, stateDirectory) }); return; }
    if (process.argv.includes("--rollback")) {
      const transactions = await listInstallationTransactions(root, stateDirectory); const requested = typeof input.transactionId === "string" ? input.transactionId : undefined;
      const selected = requested ? transactions.find((item) => item.transactionId === requested) : [...transactions].reverse().find((item) => item.kind === "install" && item.status === "committed");
      if (!selected || selected.kind !== "install") throw new Error("INSTALL_TRANSACTION_NOT_FOUND"); output(await rollbackInstallationTransaction(root, stateDirectory, selected.transactionId)); return;
    }
    output(await installConsumer(root)); return;
  }
  if (command === "repair") { output(process.argv.includes("--apply") ? await applyRepair(root) : await planRepair(root)); return; }
  if (command === "doctor") { output(await doctor(root)); return; }
  if (command === "jira") {
    if (subcommand === "configure") { output(await jiraConfigureCommand(root)); return; }
    if (subcommand === "workflow-setup") { output(await jiraWorkflowSetupCommand(root)); return; }
    if (subcommand === "enable-writes") { output(await jiraEnableWritesCommand(root)); return; }
    if (subcommand === "bind") { output(await bindJiraTaskCommand(root, await jsonInput())); return; }
    if (subcommand === "sync") { output(await jiraSyncCommand(root, await jsonInput())); return; }
    if (subcommand === "doctor") { output(await jiraDoctorCommand(root)); return; }
    throw new Error("Unknown Jira command. Supported: jira configure, jira workflow-setup, jira enable-writes, jira doctor [--issue PROJECT-123]");
  }
  if (command === "validate") { output(await validateInstallation(root)); return; }
  if (command === "capabilities") { output(await capabilityReport()); return; }
  if (command === "silo") {
    if (subcommand === "status") { output((await doctor(root)).silo); return; }
    if (subcommand === "derive") { output(await deriveSiloConsumer(root)); return; }
    throw new Error("Unknown silo command. Supported: silo status, silo derive");
  }
  if (command === "config") {
    const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
    output(subcommand === "validate" ? { valid: true, digest: effective.digest } : effective); return;
  }
  if (command === "upgrade") {
    const input = await jsonInput();
    if (process.argv.includes("--plan")) { output(await planUpgrade(root, typeof input.targetVersion === "string" ? input.targetVersion : FRAMEWORK_VERSION)); return; }
    if (process.argv.includes("--apply")) { output(await applyUpgrade(root, { targetVersion: typeof input.targetVersion === "string" ? input.targetVersion : FRAMEWORK_VERSION, authorizeStateMigration: true })); return; }
    if (process.argv.includes("--status")) { output(await upgradeStatus(root)); return; }
    if (process.argv.includes("--rollback")) { output(await rollbackUpgrade(root, typeof input.transactionId === "string" ? input.transactionId : undefined)); return; }
    output(checkUpgradeCompatibility({
      currentVersion: FRAMEWORK_VERSION,
      targetVersion: typeof input.targetVersion === "string" ? input.targetVersion : FRAMEWORK_VERSION,
      configurationSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      recordSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      eventSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    }));
    return;
  }
  if (command === "cleanup") { output(await cleanupCommand(root, process.argv.includes("--apply") ? "apply" : "dry-run")); return; }
  if (command === "archive") { output(await archiveCommand(root, await jsonInput(), process.argv.includes("--apply") ? "apply" : "dry-run")); return; }
  if (command === "supervisor") { output(await supervisorCommand(root, subcommand, await jsonInput())); return; }
  if (command === "mission") {
    if (subcommand === "start") { output(await missionStart(root, await jsonInput())); return; }
    if (subcommand === "list") { output(await missionList(root)); return; }
    if (subcommand === "status") { output(await missionStatus(root, await jsonInput())); return; }
    if (subcommand === "logs") { output(await missionLogs(root, await jsonInput())); return; }
    if (subcommand === "accept") { output(await missionAccept(root, await jsonInput())); return; }
    if (subcommand === "ask") { output(await missionAsk(root, await jsonInput())); return; }
    if (subcommand === "steer") { output(await missionSteer(root, await jsonInput())); return; }
    if (subcommand === "pause") { output(await missionPause(root, await jsonInput())); return; }
    if (subcommand === "stop" || subcommand === "cancel") { output(await missionStop(root, await jsonInput())); return; }
    if (subcommand === "resume") { output(await missionResume(root, await jsonInput())); return; }
    if (subcommand === "handover") { output(await missionHandover(root, await jsonInput())); return; }
    throw new Error("Unknown Mission command. Supported: mission start, mission list, mission status, mission logs, mission accept, mission ask, mission steer, mission pause, mission resume, mission stop, mission cancel, mission handover");
  }
  if (command === "provider") {
    if (subcommand === "doctor") { output(await providerDoctor(root, missionProvider(await jsonInput()))); return; }
    output(await observeProvider(root, subcommand ?? "", await jsonInput())); return;
  }
  if (command === "session") {
    if (subcommand === "launch") {
      throw Object.assign(new Error("`session launch` has been retired because Orbitkeep no longer places users inside provider-owned interfaces. Use `npx orbitkeep mission start --provider claude|codex`."), { code: "COMMAND_RETIRED" });
    }
    throw new Error("Unknown session command. Provider sessions are internal; use `orbitkeep mission start`.");
  }
  if (command === "control") { output(await controlCommand(root, subcommand, await jsonInput())); return; }
  output(await managerCommand(root, command, await jsonInput()));
}

function isCliEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  }
}

if (isCliEntryPoint()) {
  runCli().catch((error) => { output({ status: "failed", code: (error as { code?: string }).code ?? "CLI_ERROR", message: error instanceof Error ? error.message : String(error), ...(error instanceof AssignmentSelectionError ? { candidates: error.candidates } : {}) }, true); process.exitCode = 1; });
}
