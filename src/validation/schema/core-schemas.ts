import { CORE_EVENT_TYPES, CORE_RECORD_TYPES, type CoreRecordType } from "../../registries/catalogue.ts";
import type { JsonSchema } from "./types.ts";
import { MANAGED_WORKFLOW_COMMANDS } from "../../contracts/commands.ts";

export const SCHEMA_VERSION = "1.0";
export const SCHEMA_BASE = `https://agent-workflow.dev/schemas/${SCHEMA_VERSION}`;
const id = (name: string) => `${SCHEMA_BASE}/${name}.schema.json`;
const string = (pattern?: string): JsonSchema => ({ type: "string", minLength: 1, ...(pattern ? { pattern } : {}) });
const timestamp: JsonSchema = { type: "string", format: "date-time" };
const nullableTimestamp: JsonSchema = { type: ["string", "null"], format: "date-time" };
const positiveInteger: JsonSchema = { type: "integer", minimum: 1 };
const nonnegativeInteger: JsonSchema = { type: "integer", minimum: 0 };
const identifier = (prefix?: string): JsonSchema => string(prefix ? `^${prefix}-[A-Za-z0-9][A-Za-z0-9._-]*$` : "^[A-Za-z][A-Za-z0-9._:-]*$");
const stringArray: JsonSchema = { type: "array", items: string(), uniqueItems: true };
const strict = (schemaId: string, required: string[], properties: Record<string, JsonSchema>): JsonSchema => ({
  ...(schemaId.startsWith("#") ? {} : { $schema: "https://json-schema.org/draft/2020-12/schema", $id: schemaId }), type: "object",
  required, properties, additionalProperties: false,
});
const version = { schema_version: { const: SCHEMA_VERSION } as JsonSchema };
const recordBase = (type: string, required: string[], properties: Record<string, JsonSchema>): JsonSchema => strict(id(`records/${type}`), ["schema_version", "record_id", "record_type", "created_at", ...required], {
  ...version, record_id: identifier(), record_type: { const: type }, created_at: timestamp, updated_at: timestamp, ...properties,
});
const ref: JsonSchema = strict("#record-ref", ["record_type", "record_id"], { record_type: string(), record_id: identifier(), revision: positiveInteger });
const actor: JsonSchema = strict("#actor", ["actor_id", "actor_type"], { actor_id: identifier(), actor_type: { enum: ["executive", "manager", "specialist", "runtime", "external_system"] }, display_name: string() });
const modelSelection: JsonSchema = strict("#model-selection", ["provider", "model"], { provider: string(), model: string(), reasoning_effort: string() });
const resourceBudget: JsonSchema = { ...strict("#resource-budget", [], { inputTokens: nonnegativeInteger, outputTokens: nonnegativeInteger, totalTokens: nonnegativeInteger, costMicros: nonnegativeInteger, elapsedMs: nonnegativeInteger, maxRuns: positiveInteger }), minProperties: 1 };
const resourceUsage: JsonSchema = strict("#resource-usage", ["inputTokens", "outputTokens", "cachedInputTokens", "costMicros"], { inputTokens: nonnegativeInteger, outputTokens: nonnegativeInteger, cachedInputTokens: nonnegativeInteger, costMicros: nonnegativeInteger });
const budgetStatus: JsonSchema = strict("#budget-status", ["state", "exceededDimensions", "assessedAt"], { state: { enum: ["active", "exceeded"] }, exceededDimensions: { type: "array", items: { enum: ["inputTokens", "outputTokens", "totalTokens", "costMicros", "elapsedMs", "maxRuns"] }, uniqueItems: true }, assessedAt: timestamp });
const retryPolicy: JsonSchema = strict("#retry-policy", ["maxAttempts", "backoffSeconds"], { maxAttempts: positiveInteger, backoffSeconds: { type: "array", items: nonnegativeInteger } });
const retryState: JsonSchema = { ...strict("#retry-state", ["status", "failedExecutionId", "nextAttempt"], { status: { enum: ["available", "scheduled", "exhausted"] }, failedExecutionId: identifier("exe"), nextAttempt: positiveInteger, nextAttemptAt: timestamp }), allOf: [{ if: { type: "object", properties: { status: { const: "scheduled" } }, required: ["status"] }, then: { required: ["nextAttemptAt"] } }] };

// Extension bases deliberately allow namespaced fields; the registered extension
// schema validates those fields while this base preserves mandatory identity/time constraints.
export const extensionRecordBaseSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: id("records/extension-base"), type: "object",
  required: ["schema_version", "record_id", "record_type", "created_at"],
  properties: { ...version, record_id: identifier(), record_type: string("^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$"), created_at: timestamp, updated_at: timestamp },
  additionalProperties: true,
};
export const extensionEventPayloadBaseSchema: JsonSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: id("events/extension-base"), type: "object" };

export const eventEnvelopeSchema: JsonSchema = strict(id("event"), ["schema_version", "event_id", "event_type", "sequence", "occurred_at", "recorded_at", "actor", "recorded_by", "data"], {
  ...version, event_id: identifier("evt"), event_type: string("^[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)+$"), sequence: positiveInteger,
  occurred_at: nullableTimestamp, recorded_at: timestamp, actor, recorded_by: actor,
  assignment_id: identifier("asn"), task_id: identifier("tsk"), execution_id: identifier("exe"), action_id: identifier("act"),
  silo_id: identifier("silo"), silo_instance_id: identifier("sinst"),
  subject: ref, caused_by_event_id: identifier("evt"),
  provider_context: strict("#provider-context", ["provider"], { provider: string(), session_id: string(), process_id: string(), task_id: string() }),
  data: { type: "object" }, artifact_refs: { type: "array", items: ref },
});

const concreteOutcome = { enum: ["succeeded", "failed", "prevented", "cancelled"] } as JsonSchema;
const templateDependency = strict("#template-dependency", ["operation"], { operation: identifier(), required: { type: "boolean" }, acceptableStates: { type: "array", items: { enum: ["accepted", "closed"] }, minItems: 1, uniqueItems: true } });
const templateGate = strict("#template-gate", ["gateId", "name", "phase"], { gateId: identifier(), name: string(), phase: { enum: ["pre_dispatch", "pre_acceptance"] }, required: { type: "boolean" } });
const templateOperation = strict("#template-operation", ["key", "role", "affectedPaths"], { key: identifier(), role: identifier(), affectedPaths: stringArray, dependencies: { type: "array", items: templateDependency }, gates: { type: "array", items: templateGate }, runBudget: resourceBudget, retryPolicy, priority: { type: "integer" } });
const templateRoute: JsonSchema = {
  ...strict("#template-route", ["key", "sourceOperation", "sourceKind", "expectedValue", "targetOperation", "effect"], { key: identifier(), sourceOperation: identifier(), sourceKind: { enum: ["execution", "task", "gate"] }, gateId: identifier(), expectedValue: { enum: ["completed", "failed", "cancelled", "accepted", "rework", "closed", "skipped", "passed", "waived"] }, targetOperation: identifier(), effect: { enum: ["activate", "skip", "block", "cancel"] } }),
  allOf: [
    { if: { type: "object", properties: { sourceKind: { const: "execution" } }, required: ["sourceKind"] }, then: { properties: { expectedValue: { enum: ["completed", "failed", "cancelled"] } }, not: { required: ["gateId"] } } },
    { if: { type: "object", properties: { sourceKind: { const: "task" } }, required: ["sourceKind"] }, then: { properties: { expectedValue: { enum: ["accepted", "rework", "closed", "cancelled", "skipped"] } }, not: { required: ["gateId"] } } },
    { if: { type: "object", properties: { sourceKind: { const: "gate" } }, required: ["sourceKind"] }, then: { required: ["gateId"], properties: { expectedValue: { enum: ["passed", "failed", "waived"] } } } },
  ],
};
export const workflowTemplateSchema = strict(id("workflow-template"), ["schemaVersion", "templateId", "version", "name", "operations"], { schemaVersion: { const: "1.0" }, templateId: identifier("tpl"), version: string("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"), name: string(), description: string(), operations: { type: "array", items: templateOperation, minItems: 1 }, routes: { type: "array", items: templateRoute } });
const templateBindings = strict("#template-bindings", ["affectedPaths"], { affectedPaths: { type: "object", additionalProperties: stringArray } });

const jiraWorkflowMapping = strict("#config-jira-workflow-mapping", ["authority", "fallback"], {
  targetStatus: string(),
  authority: { enum: ["automatic", "executive", "prohibited"] },
  fallback: { enum: ["comment_only", "propose", "pending", "fail", "ignore"] },
});
const jiraMappings = strict("#config-jira-mappings", [], {
  work_started: jiraWorkflowMapping,
  work_blocked: jiraWorkflowMapping,
  work_resumed: jiraWorkflowMapping,
  rework_requested: jiraWorkflowMapping,
  work_completed: jiraWorkflowMapping,
  work_cancelled: jiraWorkflowMapping,
  work_paused: jiraWorkflowMapping,
});
const jiraWorkflowProfile = strict("#config-jira-workflow-profile", ["id", "projectKey", "issueTypes", "mappings"], {
  id: string(),
  projectKey: string(),
  issueTypes: { type: "array", items: string(), minItems: 1, uniqueItems: true },
  mappings: jiraMappings,
});

export const recordSchemas: Record<CoreRecordType, JsonSchema> = {
  configuration: strict(id("config"), ["schemaVersion", "framework", "state", "approvals", "intentLogging", "referenceValidation", "heartbeat", "retention", "supervisor", "execution", "roles", "materiality", "models", "providers", "integrations", "silo", "security"], {
    $schema: string(), schemaVersion: { const: "1.0" },
    framework: strict("#config-framework", ["minimumVersion"], { minimumVersion: string("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$") }),
    state: strict("#config-state", ["directory"], { directory: string() }),
    approvals: strict("#config-approvals", ["initialPlan", "resumePlan", "materialPlanChange"], { initialPlan: { enum: ["required", "not_required"] }, resumePlan: { enum: ["required", "not_required"] }, materialPlanChange: { enum: ["required", "not_required"] } }),
    intentLogging: strict("#config-intent", ["retryCount", "backoffSeconds"], { retryCount: { type: "integer", minimum: 0 }, backoffSeconds: { type: "array", items: { type: "number", minimum: 0 } } }),
    referenceValidation: strict("#config-reference", ["retrySeconds", "timeoutSeconds"], { retrySeconds: { type: "array", items: { type: "number", minimum: 0 } }, timeoutSeconds: positiveInteger }),
    heartbeat: strict("#config-heartbeat", ["enabled", "intervalSeconds"], { enabled: { type: "boolean" }, intervalSeconds: positiveInteger }),
    retention: strict("#config-retention", ["rawResponsesDays", "closedAssignmentsDays", "installationBackupsDays", "permanentArchiveDeletion"], { rawResponsesDays: { type: "integer", minimum: 0 }, closedAssignmentsDays: { type: "integer", minimum: 0 }, installationBackupsDays: positiveInteger, permanentArchiveDeletion: { const: false } }),
    supervisor: strict("#config-supervisor", ["idleTimeoutSeconds"], { idleTimeoutSeconds: positiveInteger }),
    execution: strict("#config-execution", ["defaultInterruptionMode", "automaticForceEscalation", "retryPolicy"], { defaultInterruptionMode: { enum: ["graceful", "force"] }, automaticForceEscalation: { const: false }, retryPolicy: strict("#config-retry-policy", ["maxAttempts", "backoffSeconds"], { maxAttempts: positiveInteger, backoffSeconds: { type: "array", items: nonnegativeInteger } }) }),
    roles: strict("#config-roles", ["enabled"], { enabled: stringArray }),
    materiality: strict("#config-materiality", ["alwaysMaterial", "delegatedChanges", "cumulativeChangeThreshold", "ambiguityBehavior"], { alwaysMaterial: stringArray, delegatedChanges: stringArray, cumulativeChangeThreshold: positiveInteger, ambiguityBehavior: { const: "hold_affected_work" } }),
    models: strict("#config-models", ["selectionAuthority", "fallback", "roles"], { selectionAuthority: { type: "array", items: { enum: ["executive", "manager_policy"] }, uniqueItems: true }, fallback: { enum: ["require_authorization", "reject"] }, roles: { type: "object", additionalProperties: strict("#config-model-policy", ["allowed"], { allowed: stringArray }) } }),
    providers: { type: "object", additionalProperties: strict("#config-provider", ["enabled"], { enabled: { type: "boolean" }, requiredMode: { enum: ["off", "instructions", "observed", "enforced", "brokered"] }, captureRawResponses: { type: "boolean", default: false } }) },
    integrations: strict("#config-integrations", ["jira"], {
      jira: strict("#config-jira", ["enabled", "mode", "projectKeys", "workflowProfiles", "scrumAgent"], {
        enabled: { type: "boolean" },
        mode: { enum: ["disabled", "observe", "propose", "automatic"] },
        siteUrl: string(),
        credentialReference: string(),
        projectKeys: stringArray,
        workflowProfiles: { type: "array", items: jiraWorkflowProfile },
        scrumAgent: strict("#config-jira-scrum-agent", ["enabled", "progressComments", "progressIntervalMinutes", "timeTracking", "estimateUpdates"], {
          enabled: { type: "boolean" },
          progressComments: { type: "boolean" },
          progressIntervalMinutes: positiveInteger,
          timeTracking: { enum: ["disabled", "observe", "automatic"] },
          estimateUpdates: { enum: ["disabled", "propose", "automatic"] },
        }),
      }),
    }),
    silo: strict("#config-silo", ["credentialProvider", "registration"], { credentialProvider: { enum: ["none", "local_file_degraded"] }, registration: strict("#config-silo-registration", ["required", "trustedAuthorityKeys"], { required: { type: "boolean" }, trustedAuthorityKeys: { type: "object", additionalProperties: string() } }) }),
    security: strict("#config-security", ["stateRootContainment", "secretRedaction", "executeRecordContent", "executiveApproval"], { stateRootContainment: { const: true }, secretRedaction: { const: true }, executeRecordContent: { const: false }, executiveApproval: strict("#config-executive-approval", ["mode", "trustedPublicKeys", "receiptMaxAgeSeconds"], { mode: { enum: ["record_only", "signed_ed25519"] }, trustedPublicKeys: { type: "object", additionalProperties: string() }, receiptMaxAgeSeconds: positiveInteger }) }),
  }),
  assignment: { ...recordBase("assignment", ["assignment_id", "objective", "lifecycle_state", "execution_authority", "ownership", "policy_snapshot"], {
    assignment_id: identifier("asn"), objective: string(), scope: stringArray, constraints: stringArray, acceptance_criteria: stringArray,
    lifecycle_state: { enum: ["planning", "awaiting_approval", "running", "blocked", "pausing", "paused", "handing_over", "handover_ready", "cancelling", "closed"] },
    closure_disposition: { enum: ["completed", "cancelled"] }, execution_authority: { enum: ["unauthorized", "authorized", "held"] },
    current_plan_id: identifier("pln"), ownership: strict("#ownership", ["manager_instance_id"], { manager_instance_id: identifier("mgr"), lease_expires_at: timestamp }),
    policy_snapshot: { type: "object" }, task_ids: { type: "array", items: identifier("tsk"), uniqueItems: true }, checkpoint_id: identifier(),
    pending_action_ids: { type: "array", items: identifier("act"), uniqueItems: true }, holds: stringArray,
    started_at: timestamp, budget: resourceBudget, budget_status: budgetStatus, usage: resourceUsage,
    nonmaterial_change_count: { type: "integer", minimum: 0 },
    closure_history: { type: "array", items: strict("#closure-history", ["disposition", "closed_at"], { disposition: { enum: ["completed", "cancelled"] }, closed_at: timestamp }) },
  }), allOf: [{ if: { type: "object", properties: { lifecycle_state: { const: "closed" } }, required: ["lifecycle_state"] }, then: { required: ["closure_disposition"] } }] },
  plan: recordBase("plan", ["plan_id", "assignment_id", "revision", "purpose", "lifecycle", "approach", "acceptance_criteria"], {
    plan_id: identifier("pln"), assignment_id: identifier("asn"), revision: positiveInteger, purpose: { enum: ["initial", "continuation", "steer"] }, lifecycle: { enum: ["draft", "proposed", "active", "superseded"] }, approach: stringArray, acceptance_criteria: stringArray, dependencies: stringArray, gates: stringArray, risks: stringArray, assumptions: stringArray, unresolved: stringArray, prior_plan_id: identifier("pln"),
  }),
  checkpoint: recordBase("checkpoint", ["checkpoint_id", "assignment_id", "kind", "summary"], { checkpoint_id: identifier(), assignment_id: identifier("asn"), kind: { enum: ["resume", "pause", "handover", "progress"] }, summary: string(), unresolved_action_ids: { type: "array", items: identifier("act") } }),
  "work-item": recordBase("work-item", ["work_item_id", "assignment_id", "title"], { work_item_id: identifier(), assignment_id: identifier("asn"), title: string(), external_ref: string(), task_ids: { type: "array", items: identifier("tsk") } }),
  task: recordBase("task", ["task_id", "assignment_id", "state", "affected_paths", "execution_ids", "result_ids"], {
    task_id: identifier("tsk"), assignment_id: identifier("asn"), state: { enum: ["draft", "ready", "dispatched", "running", "blocked", "result_submitted", "rework", "accepted", "closed", "cancelled", "skipped"] }, role: identifier(),
    affected_paths: stringArray, execution_ids: { type: "array", items: identifier("exe"), uniqueItems: true }, result_ids: { type: "array", items: identifier(), uniqueItems: true },
    dependencies: { type: "array", items: strict("#task-dependency", ["task_id", "required", "acceptable_states"], { task_id: identifier("tsk"), required: { type: "boolean" }, acceptable_states: { type: "array", items: { enum: ["accepted", "closed"] }, minItems: 1, uniqueItems: true } }) },
    gates: { type: "array", items: strict("#task-gate", ["gate_id", "name", "phase", "required", "status", "evidence_ids"], { gate_id: identifier(), name: string(), phase: { enum: ["pre_dispatch", "pre_acceptance"] }, required: { type: "boolean" }, status: { enum: ["pending", "passed", "failed", "waived"] }, evidence_ids: { type: "array", items: identifier("evd"), uniqueItems: true }, updated_at: timestamp }) }, run_budget: resourceBudget, retry_policy: retryPolicy, retry_state: retryState, priority: { type: "integer" }, created_sequence: positiveInteger,
  }),
  route: { ...recordBase("route", ["route_id", "assignment_id", "source_task_id", "source_kind", "expected_value", "target_task_id", "effect", "state"], {
    route_id: identifier("rte"), assignment_id: identifier("asn"), source_task_id: identifier("tsk"), source_kind: { enum: ["execution", "task", "gate"] }, gate_id: identifier(), expected_value: { enum: ["completed", "failed", "cancelled", "accepted", "rework", "closed", "skipped", "passed", "waived"] }, target_task_id: identifier("tsk"), effect: { enum: ["activate", "skip", "block", "cancel"] }, state: { enum: ["pending", "applied"] }, evaluated_at: timestamp, observed_value: { enum: ["completed", "failed", "cancelled", "accepted", "rework", "closed", "skipped", "passed", "waived"] },
  }), allOf: [
    { if: { type: "object", properties: { source_kind: { const: "execution" } }, required: ["source_kind"] }, then: { properties: { expected_value: { enum: ["completed", "failed", "cancelled"] }, observed_value: { enum: ["completed", "failed", "cancelled"] } }, not: { required: ["gate_id"] } } },
    { if: { type: "object", properties: { source_kind: { const: "task" } }, required: ["source_kind"] }, then: { properties: { expected_value: { enum: ["accepted", "rework", "closed", "cancelled", "skipped"] }, observed_value: { enum: ["accepted", "rework", "closed", "cancelled", "skipped"] } }, not: { required: ["gate_id"] } } },
    { if: { type: "object", properties: { source_kind: { const: "gate" } }, required: ["source_kind"] }, then: { required: ["gate_id"], properties: { expected_value: { enum: ["passed", "failed", "waived"] }, observed_value: { enum: ["passed", "failed", "waived"] } } } },
    { if: { type: "object", properties: { state: { const: "applied" } }, required: ["state"] }, then: { required: ["evaluated_at", "observed_value"] } },
  ] },
  "template-application": recordBase("template-application", ["application_id", "assignment_id", "template_id", "template_version", "template_digest", "template_snapshot", "bindings", "operation_bindings", "route_bindings"], {
    application_id: identifier("tapp"), assignment_id: identifier("asn"), template_id: identifier("tpl"), template_version: string("^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"), template_digest: string("^sha256:[A-Fa-f0-9]{64}$"), template_snapshot: workflowTemplateSchema, bindings: templateBindings, operation_bindings: { type: "object", additionalProperties: identifier("tsk") }, route_bindings: { type: "object", additionalProperties: identifier("rte") },
  }),
  "task-packet": recordBase("task-packet", ["task_id", "execution_id", "assignment_id", "objective", "scope", "exclusions", "acceptance_criteria", "permissions", "constraints", "expected_outputs", "requested_model"], {
    task_id: identifier("tsk"), execution_id: identifier("exe"), assignment_id: identifier("asn"), parent_task_id: identifier("tsk"), objective: string(), purpose: string(), scope: stringArray, exclusions: stringArray,
    acceptance_criteria: { type: "array", items: strict("#criterion", ["id", "text"], { id: identifier(), text: string() }) }, authoritative_inputs: { type: "array", items: ref }, starting_point: string(), permissions: stringArray, constraints: stringArray, dependencies: { type: "array", items: ref }, expected_outputs: stringArray, evidence_requirements: stringArray, escalation_conditions: stringArray, stopping_conditions: stringArray, requested_model: modelSelection, actual_model: modelSelection,
  }),
  execution: recordBase("execution", ["execution_id", "task_id", "assignment_id", "attempt", "state"], { execution_id: identifier("exe"), task_id: identifier("tsk"), assignment_id: identifier("asn"), attempt: positiveInteger, run_kind: { enum: ["initial", "retry", "rework"] }, retry_attempt: positiveInteger, state: { enum: ["ready", "running", "completed", "failed", "cancelled", "unknown"] }, started_at: timestamp, ended_at: timestamp, budget: resourceBudget, budget_status: budgetStatus, usage: resourceUsage, requested_model: modelSelection, actual_model: modelSelection, provider_execution_id: string(), result_id: identifier() }),
  action: recordBase("action", ["action_id", "assignment_id", "description", "outcome"], { action_id: identifier("act"), assignment_id: identifier("asn"), task_id: identifier("tsk"), execution_id: identifier("exe"), description: string(), consequential: { type: "boolean" }, outcome: { enum: ["requested", "started", "succeeded", "failed", "prevented", "cancelled", "unknown"] }, intent_event_id: identifier("evt"), outcome_event_id: identifier("evt") }),
  result: recordBase("result", ["result_id", "assignment_id", "task_id", "execution_id", "delivery_status", "summary"], { result_id: identifier(), assignment_id: identifier("asn"), task_id: identifier("tsk"), execution_id: identifier("exe"), delivery_status: { enum: ["complete", "partial", "failed"] }, summary: string(), artifact_refs: { type: "array", items: ref }, evidence_refs: { type: "array", items: identifier() } }),
  assessment: recordBase("assessment", ["assessment_id", "assignment_id", "subject", "classification", "rationale"], { assessment_id: identifier(), assignment_id: identifier("asn"), subject: ref, classification: { enum: ["nonmaterial", "material", "ambiguous"] }, rationale: string(), cumulative_change_count: { type: "integer", minimum: 0 }, affected_paths: stringArray, code: string() }),
  approval: { ...recordBase("approval", ["approval_id", "assignment_id", "subject", "subject_revision", "state", "approver", "scope"], { approval_id: identifier("apr"), assignment_id: identifier("asn"), subject: ref, subject_revision: positiveInteger, state: { enum: ["requested", "granted", "rejected", "revoked", "expired", "waived"] }, approver: actor, scope: string(), granted_at: timestamp, expires_at: timestamp, waiver_authority: actor, verification: strict("#approval-verification", ["mode"], { mode: { enum: ["record_only", "signed_ed25519"] }, key_id: string(), receipt_digest: string("^sha256:[A-Fa-f0-9]{64}$") }) }), allOf: [
    { if: { type: "object", properties: { state: { const: "granted" } }, required: ["state"] }, then: { required: ["granted_at"] } },
    { if: { type: "object", properties: { state: { const: "waived" } }, required: ["state"] }, then: { required: ["waiver_authority"] } },
  ] },
  decision: recordBase("decision", ["decision_id", "assignment_id", "subject", "choice", "rationale", "decided_by"], { decision_id: identifier("dec"), assignment_id: identifier("asn"), subject: ref, choice: string(), rationale: string(), decided_by: actor }),
  evidence: recordBase("evidence", ["evidence_id", "assignment_id", "subject", "kind", "location", "digest"], { evidence_id: identifier("evd"), assignment_id: identifier("asn"), subject: ref, kind: string(), location: string(), digest: string("^[A-Za-z0-9]+:[A-Fa-f0-9]+$") }),
  escalation: recordBase("escalation", ["escalation_id", "assignment_id", "subject", "status", "reason"], { escalation_id: identifier(), assignment_id: identifier("asn"), subject: ref, status: { enum: ["open", "resolved"] }, reason: string(), resolution: string() }),
  pending: { ...recordBase("pending", ["pending_id", "action_id", "status"], { pending_id: identifier(), action_id: identifier("act"), assignment_id: identifier("asn"), silo_id: identifier("silo"), request_id: identifier("sreq"), status: { const: "unresolved" }, observed_outcome: { const: "unknown" }, reconciled_outcome: concreteOutcome }), anyOf: [{ required: ["assignment_id"] }, { required: ["silo_id", "request_id"] }] },
  quarantine: { ...recordBase("quarantine", ["quarantine_id", "submission", "validation_errors", "status"], { quarantine_id: identifier(), submission: {}, validation_errors: { type: "array", items: strict("#quarantine-error", ["code", "message", "instance_path"], { code: string(), message: string(), instance_path: { type: "string" }, schema_path: { type: "string" } }) }, status: { enum: ["unresolved", "resolved"] }, resolution: string() }), allOf: [{ if: { type: "object", properties: { status: { const: "resolved" } }, required: ["status"] }, then: { required: ["resolution"] } }] },
  hold: recordBase("hold", ["hold_id", "targets", "placed_by", "reason", "scope", "status"], { hold_id: identifier(), targets: { type: "array", items: ref }, placed_by: actor, reason: string(), scope: { enum: ["archive", "delete", "archive_and_delete"] }, status: { enum: ["active", "released", "expired"] }, expires_at: timestamp, released_at: timestamp }),
  "archive-manifest": recordBase("archive-manifest", ["manifest_id", "batch_id", "entries", "status"], { manifest_id: identifier(), batch_id: identifier(), entries: { type: "array", items: strict("#archive-entry", ["record", "source", "destination", "digest"], { record: ref, source: string(), destination: string(), digest: string() }) }, status: { enum: ["prepared", "verified", "published", "failed"] } }),
  "cleanup-manifest": recordBase("cleanup-manifest", ["manifest_id", "mode", "entries", "status"], { manifest_id: identifier(), mode: { enum: ["dry-run", "apply"] }, entries: { type: "array", items: strict("#cleanup-entry", ["target", "reason"], { target: string(), reason: string(), digest: string() }) }, status: { enum: ["planned", "completed", "failed"] } }),
  "awaiting-validation": recordBase("awaiting-validation", ["submission_id", "deadline_at", "retry_seconds", "attempted_at", "next_retry_at", "missing_references", "validation_errors", "submission"], {
    submission_id: identifier(), deadline_at: timestamp, retry_seconds: { type: "array", items: { type: "number", minimum: 0 } }, attempted_at: { type: "array", items: timestamp }, next_retry_at: nullableTimestamp,
    missing_references: stringArray, validation_errors: { type: "array", items: strict("#awaiting-error", ["code", "message", "instance_path"], { code: string(), message: string(), instance_path: { type: "string" }, schema_path: { type: "string" } }) }, submission: {},
  }),
  "action-reconciliation": { ...recordBase("action-reconciliation", ["reconciliation_id", "action_id", "operation_id", "outcome", "reconciled_at", "rationale"], {
    reconciliation_id: identifier(), action_id: identifier("act"), assignment_id: identifier("asn"), silo_id: identifier("silo"), request_id: identifier("sreq"), operation_id: identifier(), outcome: concreteOutcome, reconciled_at: timestamp, rationale: string(), evidence_refs: stringArray,
  }), anyOf: [{ required: ["assignment_id"] }, { required: ["silo_id", "request_id"] }] },
  "raw-response": recordBase("raw-response", ["response_id", "provider", "source_event", "captured_at", "retention_until", "content"], {
    response_id: identifier(), provider: string(), source_event: string(), captured_at: timestamp, retention_until: timestamp, assignment_id: identifier("asn"), task_id: identifier("tsk"), execution_id: identifier("exe"), content: {},
  }),
  "usage-observation": recordBase("usage-observation", ["observation_id", "assignment_id", "task_id", "execution_id", "provider", "model", "measurement", "observed_at", "input_tokens", "output_tokens", "cached_input_tokens", "cost_micros"], {
    observation_id: identifier(), assignment_id: identifier("asn"), task_id: identifier("tsk"), execution_id: identifier("exe"), provider: string(), model: string(), measurement: { enum: ["observed", "estimated"] }, observed_at: timestamp, input_tokens: nonnegativeInteger, output_tokens: nonnegativeInteger, cached_input_tokens: nonnegativeInteger, cost_micros: nonnegativeInteger,
  }),
  "silo-descriptor": strict(id("records/silo-descriptor"), ["schema_version", "silo_id", "created_at", "identity_version"], {
    ...version, silo_id: identifier("silo"), created_at: timestamp, identity_version: positiveInteger,
    derived_from_silo_id: identifier("silo"),
    origin_hint: strict("#silo-origin-hint", ["provider", "repository"], { provider: { enum: ["github", "gitlab", "bitbucket", "other"] }, repository: string("^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+$") }),
  }),
  "silo-instance": strict(id("records/silo-instance"), ["schema_version", "silo_instance_id", "silo_id", "created_at", "last_started_at", "instance_version", "workspace_fingerprint"], {
    ...version, silo_instance_id: identifier("sinst"), silo_id: identifier("silo"), created_at: timestamp, last_started_at: timestamp, instance_version: positiveInteger, workspace_fingerprint: string("^sha256:[A-Fa-f0-9]{64}$"),
  }),
  "silo-registration-request": strict(id("records/silo-registration-request"), ["schema_version", "request_id", "idempotency_id", "silo_id", "silo_instance_id", "public_key", "key_id", "keep_id", "capability_digest", "charter", "issued_at", "expires_at", "nonce"], {
    ...version, request_id: identifier("sreq"), idempotency_id: identifier(), silo_id: identifier("silo"), silo_instance_id: identifier("sinst"), public_key: string(), key_id: identifier(), keep_id: identifier("keep"), colony_id: identifier("col"), capability_digest: string("^sha256:[A-Fa-f0-9]{64}$"), charter: strict("#silo-charter-compatibility", ["schema_version"], { schema_version: string(), charter_id: identifier(), digest: string("^sha256:[A-Fa-f0-9]{64}$") }), issued_at: timestamp, expires_at: timestamp, nonce: identifier(), signature: string(),
  }),
  "silo-registration-receipt": strict(id("records/silo-registration-receipt"), ["schema_version", "registration_id", "registration_version", "silo_id", "public_key_fingerprint", "keep_id", "granted_capabilities", "charter", "status", "issued_at", "revalidate_at", "authority_key_id", "idempotency_id", "signature"], {
    ...version, registration_id: identifier("sreg"), registration_version: positiveInteger, silo_id: identifier("silo"), public_key_fingerprint: string("^sha256:[A-Fa-f0-9]{64}$"), keep_id: identifier("keep"), colony_id: identifier("col"), granted_capabilities: stringArray, charter: strict("#silo-charter-receipt", ["charter_id", "version", "digest"], { charter_id: identifier(), version: string(), digest: string("^sha256:[A-Fa-f0-9]{64}$") }), status: { enum: ["active", "revoked", "expired", "retired"] }, issued_at: timestamp, expires_at: timestamp, revalidate_at: timestamp, authority_key_id: identifier(), idempotency_id: identifier(), signature: string(),
  }),
  "silo-capabilities": strict(id("records/silo-capabilities"), ["schema_version", "silo_id", "silo_instance_id", "observed_at", "capabilities", "digest"], {
    ...version, silo_id: identifier("silo"), silo_instance_id: identifier("sinst"), observed_at: timestamp, capabilities: stringArray, digest: string("^sha256:[A-Fa-f0-9]{64}$"),
  }),
  "silo-connection-observation": { ...strict(id("records/silo-connection-observation"), ["schema_version", "silo_id", "silo_instance_id", "state", "observed_at"], {
    ...version, silo_id: identifier("silo"), silo_instance_id: identifier("sinst"), state: { enum: ["offline", "connecting", "connected", "disconnected"] }, observed_at: timestamp, valid_until: timestamp, session_id: string(), reason: string(),
  }), allOf: [{ if: { type: "object", properties: { state: { const: "connected" } }, required: ["state"] }, then: { required: ["valid_until"] } }] },
  "silo-health-assessment": strict(id("records/silo-health-assessment"), ["schema_version", "silo_id", "silo_instance_id", "state", "assessed_at", "findings"], {
    ...version, silo_id: identifier("silo"), silo_instance_id: identifier("sinst"), state: { enum: ["healthy", "degraded", "blocked"] }, assessed_at: timestamp, findings: { type: "array", items: strict("#silo-health-finding", ["code", "level", "message"], { code: string(), level: { enum: ["enforced", "observed", "instructed", "unsupported"] }, message: string() }) },
  }),
  "silo-key-metadata": strict(id("records/silo-key-metadata"), ["schema_version", "silo_id", "active_key_id", "public_keys", "provider", "protection", "updated_at"], {
    ...version, silo_id: identifier("silo"), active_key_id: identifier(), public_keys: { type: "array", items: strict("#silo-public-key", ["key_id", "algorithm", "public_key", "fingerprint", "status", "created_at"], { key_id: identifier(), algorithm: { const: "ed25519" }, public_key: string(), fingerprint: string("^sha256:[A-Fa-f0-9]{64}$"), status: { enum: ["active", "overlap", "retired"] }, created_at: timestamp, retire_at: timestamp }) }, provider: string(), protection: { enum: ["hardened", "local_file_degraded", "unavailable"] }, updated_at: timestamp,
  }),
};

if (Object.keys(recordSchemas).length !== CORE_RECORD_TYPES.length) throw new Error("Core record schema catalogue is incomplete.");

function payloadFor(eventType: string): JsonSchema {
  const properties: Record<string, JsonSchema> = { message: string(), reason: string(), status: string(), record_ref: ref, error: { type: "object" }, details: { type: "object" } };
  let required: string[] = [];
  if (eventType.startsWith("manager.command_")) {
    properties.command_id = identifier(); properties.command = { enum: [...MANAGED_WORKFLOW_COMMANDS] }; required = ["command_id", "command"];
  } else if (["manager.question_received", "manager.answer_provided", "manager.status_reported"].includes(eventType)) {
    required = ["message"];
  } else if (eventType === "provider.signal_observed") {
    properties.provider = string(); properties.signal = string(); required = ["provider", "signal"];
  } else if (eventType.startsWith("execution.")) {
    properties.execution_id = identifier("exe"); required = ["execution_id"];
  } else if (eventType.startsWith("action.")) {
    properties.action_id = identifier("act"); required = ["action_id"];
  } else if (eventType.startsWith("submission.")) {
    properties.submission_id = identifier(); required = ["submission_id"];
  } else if (eventType === "runtime.operation_blocked") {
    properties.operation_id = identifier(); required = ["operation_id", "reason"];
  } else if (eventType === "framework.migration_completed" || eventType === "framework.migration_rolled_back") {
    properties.from_version = string(); properties.to_version = string(); properties.transaction_id = identifier("itx"); required = ["from_version", "to_version", "transaction_id"];
  } else if (eventType.startsWith("silo.")) {
    properties.silo_id = identifier("silo"); properties.silo_instance_id = identifier("sinst"); properties.derived_from_silo_id = identifier("silo");
    properties.request_id = identifier("sreq"); properties.registration_id = identifier("sreg");
    properties.capability_digest = string("^sha256:[A-Fa-f0-9]{64}$"); properties.state = string(); properties.health_state = { enum: ["healthy", "degraded", "blocked"] };
    required = eventType === "silo.instance_created" ? ["silo_id", "silo_instance_id"] : eventType === "silo.identity_derived" ? ["silo_id", "derived_from_silo_id"] : ["silo_id"];
  } else {
    required = ["record_ref"];
  }
  return strict(id(`events/${eventType}`), required, properties);
}
export const eventPayloadSchemas = Object.fromEntries(CORE_EVENT_TYPES.map((eventType) => [eventType, payloadFor(eventType)])) as Record<(typeof CORE_EVENT_TYPES)[number], JsonSchema>;

// Payload constraints with semantics that are core invariants.
eventPayloadSchemas["action.reconciled"] = strict(id("events/action.reconciled"), ["action_id", "concrete_outcome"], { action_id: identifier("act"), concrete_outcome: concreteOutcome, rationale: string() });
eventPayloadSchemas["action.outcome_unknown"] = strict(id("events/action.outcome_unknown"), ["action_id", "outcome"], { action_id: identifier("act"), outcome: { const: "unknown" }, reason: string() });
for (const terminal of ["succeeded", "failed", "prevented", "cancelled"] as const) eventPayloadSchemas[`action.${terminal}`] = strict(id(`events/action.${terminal}`), ["action_id", "outcome"], { action_id: identifier("act"), outcome: { const: terminal }, reason: string() });
eventPayloadSchemas["approval.requested"] = strict(id("events/approval.requested"), ["approval_id", "subject", "subject_revision"], { approval_id: identifier("apr"), subject: ref, subject_revision: positiveInteger });
eventPayloadSchemas["event.corrected"] = strict(id("events/event.corrected"), ["corrected_event_id", "correction"], { corrected_event_id: identifier("evt"), correction: { type: "object" }, reason: string() });

export const coreSchemas = [eventEnvelopeSchema, extensionRecordBaseSchema, extensionEventPayloadBaseSchema, ...Object.values(recordSchemas), ...Object.values(eventPayloadSchemas)];
