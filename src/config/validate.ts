import type {
  ConfigurationExtension,
  FrameworkConfiguration,
  MachineLocalConfiguration,
} from "../contracts/configuration.ts";
import { AgentWorkflowError } from "../contracts/errors.ts";

type JsonObject = Record<string, unknown>;
interface ConfigurationShape {
  readonly [key: string]: true | "map" | ConfigurationShape;
}

const SHAPE = {
  schemaVersion: true,
  framework: { minimumVersion: true },
  state: { directory: true },
  approvals: { initialPlan: true, resumePlan: true, materialPlanChange: true },
  intentLogging: { retryCount: true, backoffSeconds: true },
  referenceValidation: { retrySeconds: true, timeoutSeconds: true },
  heartbeat: { enabled: true, intervalSeconds: true },
  supervisor: { idleTimeoutSeconds: true },
  retention: {
    rawResponsesDays: true,
    closedAssignmentsDays: true,
    installationBackupsDays: true,
    permanentArchiveDeletion: true,
  },
  execution: { defaultInterruptionMode: true, automaticForceEscalation: true, retryPolicy: { maxAttempts: true, backoffSeconds: true } },
  roles: { enabled: true },
  materiality: {
    alwaysMaterial: true,
    delegatedChanges: true,
    cumulativeChangeThreshold: true,
    ambiguityBehavior: true,
  },
  models: { selectionAuthority: true, fallback: true, roles: "map" },
  providers: "map",
  integrations: {
    jira: {
      enabled: true,
      mode: true,
      siteUrl: true,
      credentialReference: true,
      projectKeys: true,
      workflowProfiles: true,
      scrumAgent: {
        enabled: true,
        progressComments: true,
        progressIntervalMinutes: true,
        timeTracking: true,
        estimateUpdates: true,
      },
    },
  },
  silo: { credentialProvider: true, registration: { required: true, trustedAuthorityKeys: "map" } },
  security: { stateRootContainment: true, secretRedaction: true, executeRecordContent: true, executiveApproval: { mode: true, trustedPublicKeys: "map", receiptMaxAgeSeconds: true } },
} as const;

const LOCAL_SHAPE = {
  machineId: true,
  providerExecutables: "map",
  cacheDirectory: true,
  scheduler: { enabled: true },
  concurrency: { maxOperations: true },
  secretReferences: "map",
} as const;

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentWorkflowError({
      code: "CONFIG_INVALID_TYPE",
      message: `Expected an object at ${path}.`,
      path,
    });
  }
  return value as JsonObject;
}

function assertKnownKeys(
  value: JsonObject,
  shape: ConfigurationShape,
  path: string,
): void {
  for (const [key, entry] of Object.entries(value)) {
    const expected = shape[key];
    const entryPath = `${path}.${key}`;
    if (expected === undefined) {
      throw new AgentWorkflowError({
        code: "CONFIG_UNKNOWN_KEY",
        message: `Unknown configuration key ${entryPath}.`,
        path: entryPath,
      });
    }
    if (typeof expected === "object") {
      assertKnownKeys(object(entry, entryPath), expected, entryPath);
    } else if (expected === "map") {
      object(entry, entryPath);
    }
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentWorkflowError({ code: "CONFIG_INVALID_VALUE", message: `Expected a non-empty string at ${path}.`, path });
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new AgentWorkflowError({ code: "CONFIG_INVALID_TYPE", message: `Expected a boolean at ${path}.`, path });
  }
}

function assertInteger(value: unknown, path: string, minimum = 0): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new AgentWorkflowError({ code: "CONFIG_INVALID_VALUE", message: `Expected an integer >= ${minimum} at ${path}.`, path });
  }
}

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new AgentWorkflowError({ code: "CONFIG_INVALID_VALUE", message: `Expected non-empty strings at ${path}.`, path });
  }
}

function assertNumberArray(value: unknown, path: string): asserts value is number[] {
  if (!Array.isArray(value) || value.some((entry) => !Number.isFinite(entry) || entry < 0)) {
    throw new AgentWorkflowError({ code: "CONFIG_INVALID_VALUE", message: `Expected non-negative numbers at ${path}.`, path });
  }
}

function present(container: JsonObject | undefined, key: string): unknown {
  return container?.[key];
}

function validateMapOfStrings(value: unknown, path: string): void {
  for (const [key, entry] of Object.entries(object(value, path))) {
    assertString(entry, `${path}.${key}`);
  }
}

function validateJiraWorkflowProfiles(value: unknown, path: string): void {
  if (!Array.isArray(value)) invalid(path, "configuration");
  const intents = new Set(["work_started", "work_blocked", "work_resumed", "rework_requested", "work_completed", "work_cancelled", "work_paused"]);
  for (const [index, entry] of value.entries()) {
    const profilePath = `${path}.${index}`;
    const profile = object(entry, profilePath);
    assertKnownKeys(profile, { id: true, projectKey: true, issueTypes: true, mappings: "map" }, profilePath);
    assertString(profile.id, `${profilePath}.id`);
    assertString(profile.projectKey, `${profilePath}.projectKey`);
    assertStringArray(profile.issueTypes, `${profilePath}.issueTypes`);
    const mappings = object(profile.mappings, `${profilePath}.mappings`);
    for (const [intent, mappingValue] of Object.entries(mappings)) {
      if (!intents.has(intent)) invalid(`${profilePath}.mappings.${intent}`, "configuration");
      const mapping = object(mappingValue, `${profilePath}.mappings.${intent}`);
      assertKnownKeys(mapping, { targetStatus: true, authority: true, fallback: true }, `${profilePath}.mappings.${intent}`);
      if (mapping.targetStatus !== undefined) assertString(mapping.targetStatus, `${profilePath}.mappings.${intent}.targetStatus`);
      if (!["automatic", "executive", "prohibited"].includes(mapping.authority as string)) invalid(`${profilePath}.mappings.${intent}.authority`, "configuration");
      if (!["comment_only", "propose", "pending", "fail", "ignore"].includes(mapping.fallback as string)) invalid(`${profilePath}.mappings.${intent}.fallback`, "configuration");
    }
  }
}

export function validateConfigurationLayer(input: unknown, source = "configuration"): JsonObject {
  const root = object(input, source);
  const withoutSchema = { ...root };
  if ("$schema" in withoutSchema) {
    assertString(withoutSchema.$schema, `${source}.$schema`);
    delete withoutSchema.$schema;
  }
  assertKnownKeys(withoutSchema, SHAPE, source);

  const framework = present(withoutSchema, "framework") as JsonObject | undefined;
  const state = present(withoutSchema, "state") as JsonObject | undefined;
  const approvals = present(withoutSchema, "approvals") as JsonObject | undefined;
  const intent = present(withoutSchema, "intentLogging") as JsonObject | undefined;
  const references = present(withoutSchema, "referenceValidation") as JsonObject | undefined;
  const heartbeat = present(withoutSchema, "heartbeat") as JsonObject | undefined;
  const supervisor = present(withoutSchema, "supervisor") as JsonObject | undefined;
  const retention = present(withoutSchema, "retention") as JsonObject | undefined;
  const execution = present(withoutSchema, "execution") as JsonObject | undefined;
  const roles = present(withoutSchema, "roles") as JsonObject | undefined;
  const materiality = present(withoutSchema, "materiality") as JsonObject | undefined;
  const models = present(withoutSchema, "models") as JsonObject | undefined;
  const integrations = present(withoutSchema, "integrations") as JsonObject | undefined;
  const security = present(withoutSchema, "security") as JsonObject | undefined;
  const silo = present(withoutSchema, "silo") as JsonObject | undefined;

  if (withoutSchema.schemaVersion !== undefined && withoutSchema.schemaVersion !== "1.0") invalid("schemaVersion", source);
  if (framework?.minimumVersion !== undefined) assertString(framework.minimumVersion, `${source}.framework.minimumVersion`);
  if (state?.directory !== undefined) assertString(state.directory, `${source}.state.directory`);
  for (const key of ["initialPlan", "resumePlan", "materialPlanChange"]) {
    const value = approvals?.[key];
    if (value !== undefined && value !== "required" && value !== "not_required") invalid(`approvals.${key}`, source);
  }
  if (intent?.retryCount !== undefined) assertInteger(intent.retryCount, `${source}.intentLogging.retryCount`);
  if (intent?.backoffSeconds !== undefined) assertNumberArray(intent.backoffSeconds, `${source}.intentLogging.backoffSeconds`);
  if (references?.retrySeconds !== undefined) assertNumberArray(references.retrySeconds, `${source}.referenceValidation.retrySeconds`);
  if (references?.timeoutSeconds !== undefined) assertInteger(references.timeoutSeconds, `${source}.referenceValidation.timeoutSeconds`, 1);
  if (heartbeat?.enabled !== undefined) assertBoolean(heartbeat.enabled, `${source}.heartbeat.enabled`);
  if (heartbeat?.intervalSeconds !== undefined) assertInteger(heartbeat.intervalSeconds, `${source}.heartbeat.intervalSeconds`, 1);
  if (supervisor?.idleTimeoutSeconds !== undefined) assertInteger(supervisor.idleTimeoutSeconds, `${source}.supervisor.idleTimeoutSeconds`, 1);
  if (retention?.rawResponsesDays !== undefined) assertInteger(retention.rawResponsesDays, `${source}.retention.rawResponsesDays`);
  if (retention?.closedAssignmentsDays !== undefined) assertInteger(retention.closedAssignmentsDays, `${source}.retention.closedAssignmentsDays`);
  if (retention?.installationBackupsDays !== undefined) assertInteger(retention.installationBackupsDays, `${source}.retention.installationBackupsDays`, 1);
  if (retention?.permanentArchiveDeletion !== undefined && retention.permanentArchiveDeletion !== false) invalid("retention.permanentArchiveDeletion", source, "CONFIG_INVARIANT_VIOLATION");
  if (execution?.defaultInterruptionMode !== undefined && !["graceful", "force"].includes(execution.defaultInterruptionMode as string)) invalid("execution.defaultInterruptionMode", source);
  if (execution?.automaticForceEscalation !== undefined && execution.automaticForceEscalation !== false) invalid("execution.automaticForceEscalation", source, "CONFIG_INVARIANT_VIOLATION");
  const retryPolicy = execution?.retryPolicy as JsonObject | undefined;
  if (retryPolicy?.maxAttempts !== undefined) assertInteger(retryPolicy.maxAttempts, `${source}.execution.retryPolicy.maxAttempts`, 1);
  if (retryPolicy?.backoffSeconds !== undefined) assertNumberArray(retryPolicy.backoffSeconds, `${source}.execution.retryPolicy.backoffSeconds`);
  if (roles?.enabled !== undefined) assertStringArray(roles.enabled, `${source}.roles.enabled`);
  if (materiality?.alwaysMaterial !== undefined) assertStringArray(materiality.alwaysMaterial, `${source}.materiality.alwaysMaterial`);
  if (materiality?.delegatedChanges !== undefined) assertStringArray(materiality.delegatedChanges, `${source}.materiality.delegatedChanges`);
  if (materiality?.cumulativeChangeThreshold !== undefined) assertInteger(materiality.cumulativeChangeThreshold, `${source}.materiality.cumulativeChangeThreshold`, 1);
  if (materiality?.ambiguityBehavior !== undefined && materiality.ambiguityBehavior !== "hold_affected_work") invalid("materiality.ambiguityBehavior", source);
  if (models?.selectionAuthority !== undefined) {
    assertStringArray(models.selectionAuthority, `${source}.models.selectionAuthority`);
    if (models.selectionAuthority.some((entry) => entry !== "executive" && entry !== "manager_policy")) invalid("models.selectionAuthority", source);
  }
  if (models?.fallback !== undefined && !["require_authorization", "reject"].includes(models.fallback as string)) invalid("models.fallback", source);
  if (models?.roles !== undefined) {
    for (const [role, policyValue] of Object.entries(object(models.roles, `${source}.models.roles`))) {
      const policy = object(policyValue, `${source}.models.roles.${role}`);
      assertKnownKeys(policy, { allowed: true }, `${source}.models.roles.${role}`);
      if (policy.allowed !== undefined) assertStringArray(policy.allowed, `${source}.models.roles.${role}.allowed`);
    }
  }
  if (withoutSchema.providers !== undefined) {
    for (const [provider, policyValue] of Object.entries(object(withoutSchema.providers, `${source}.providers`))) {
      const policy = object(policyValue, `${source}.providers.${provider}`);
      assertKnownKeys(policy, { enabled: true, requiredMode: true, captureRawResponses: true }, `${source}.providers.${provider}`);
      if (policy.enabled !== undefined) assertBoolean(policy.enabled, `${source}.providers.${provider}.enabled`);
      if (policy.requiredMode !== undefined && !["off", "instructions", "observed", "enforced", "brokered"].includes(policy.requiredMode as string)) invalid(`providers.${provider}.requiredMode`, source);
      if (policy.captureRawResponses !== undefined) assertBoolean(policy.captureRawResponses, `${source}.providers.${provider}.captureRawResponses`);
    }
  }
  const jira = integrations?.jira as JsonObject | undefined;
  if (jira?.enabled !== undefined) assertBoolean(jira.enabled, `${source}.integrations.jira.enabled`);
  if (jira?.mode !== undefined && !["disabled", "observe", "propose", "automatic"].includes(jira.mode as string)) invalid("integrations.jira.mode", source);
  if (jira?.siteUrl !== undefined) assertString(jira.siteUrl, `${source}.integrations.jira.siteUrl`);
  if (jira?.credentialReference !== undefined) assertString(jira.credentialReference, `${source}.integrations.jira.credentialReference`);
  if (jira?.projectKeys !== undefined) assertStringArray(jira.projectKeys, `${source}.integrations.jira.projectKeys`);
  if (jira?.workflowProfiles !== undefined) validateJiraWorkflowProfiles(jira.workflowProfiles, `${source}.integrations.jira.workflowProfiles`);
  const scrumAgent = jira?.scrumAgent as JsonObject | undefined;
  if (scrumAgent?.enabled !== undefined) assertBoolean(scrumAgent.enabled, `${source}.integrations.jira.scrumAgent.enabled`);
  if (scrumAgent?.progressComments !== undefined) assertBoolean(scrumAgent.progressComments, `${source}.integrations.jira.scrumAgent.progressComments`);
  if (scrumAgent?.progressIntervalMinutes !== undefined) assertInteger(scrumAgent.progressIntervalMinutes, `${source}.integrations.jira.scrumAgent.progressIntervalMinutes`, 1);
  if (scrumAgent?.timeTracking !== undefined && !["disabled", "observe", "automatic"].includes(scrumAgent.timeTracking as string)) invalid("integrations.jira.scrumAgent.timeTracking", source);
  if (scrumAgent?.estimateUpdates !== undefined && !["disabled", "propose", "automatic"].includes(scrumAgent.estimateUpdates as string)) invalid("integrations.jira.scrumAgent.estimateUpdates", source);
  if (jira?.enabled !== undefined && jira?.mode !== undefined && (jira.enabled === (jira.mode === "disabled"))) invalid("integrations.jira", source, "CONFIG_INVARIANT_VIOLATION");
  if (silo?.credentialProvider !== undefined && !["none", "local_file_degraded"].includes(silo.credentialProvider as string)) invalid("silo.credentialProvider", source);
  const siloRegistration = silo?.registration as JsonObject | undefined;
  if (siloRegistration?.required !== undefined) assertBoolean(siloRegistration.required, `${source}.silo.registration.required`);
  if (siloRegistration?.trustedAuthorityKeys !== undefined) validateMapOfStrings(siloRegistration.trustedAuthorityKeys, `${source}.silo.registration.trustedAuthorityKeys`);
  if (security?.stateRootContainment !== undefined && security.stateRootContainment !== true) invalid("security.stateRootContainment", source, "CONFIG_INVARIANT_VIOLATION");
  if (security?.secretRedaction !== undefined && security.secretRedaction !== true) invalid("security.secretRedaction", source, "CONFIG_INVARIANT_VIOLATION");
  if (security?.executeRecordContent !== undefined && security.executeRecordContent !== false) invalid("security.executeRecordContent", source, "CONFIG_INVARIANT_VIOLATION");
  const executiveApproval = security?.executiveApproval as JsonObject | undefined;
  if (executiveApproval?.mode !== undefined && !["record_only", "signed_ed25519"].includes(executiveApproval.mode as string)) invalid("security.executiveApproval.mode", source);
  if (executiveApproval?.trustedPublicKeys !== undefined) validateMapOfStrings(executiveApproval.trustedPublicKeys, `${source}.security.executiveApproval.trustedPublicKeys`);
  if (executiveApproval?.receiptMaxAgeSeconds !== undefined) assertInteger(executiveApproval.receiptMaxAgeSeconds, `${source}.security.executiveApproval.receiptMaxAgeSeconds`, 1);
  return withoutSchema;
}

function invalid(path: string, source: string, code: "CONFIG_INVALID_VALUE" | "CONFIG_INVARIANT_VIOLATION" = "CONFIG_INVALID_VALUE"): never {
  throw new AgentWorkflowError({ code, message: `Invalid value at ${source}.${path}.`, path: `${source}.${path}` });
}

export function validateMachineConfiguration(input: unknown, source = "local configuration"): MachineLocalConfiguration {
  const root = object(input, source);
  const governanceKeys = new Set(Object.keys(SHAPE));
  const attemptedGovernanceKey = Object.keys(root).find((key) => governanceKeys.has(key));
  if (attemptedGovernanceKey !== undefined) {
    throw new AgentWorkflowError({
      code: "CONFIG_LOCAL_GOVERNANCE_OVERRIDE",
      message: `Machine-local configuration cannot override ${attemptedGovernanceKey}.`,
      path: `${source}.${attemptedGovernanceKey}`,
    });
  }
  assertKnownKeys(root, LOCAL_SHAPE, source);
  if (root.machineId !== undefined) assertString(root.machineId, `${source}.machineId`);
  if (root.cacheDirectory !== undefined) assertString(root.cacheDirectory, `${source}.cacheDirectory`);
  if (root.providerExecutables !== undefined) validateMapOfStrings(root.providerExecutables, `${source}.providerExecutables`);
  if (root.secretReferences !== undefined) validateMapOfStrings(root.secretReferences, `${source}.secretReferences`);
  const scheduler = root.scheduler as JsonObject | undefined;
  if (scheduler?.enabled !== undefined) assertBoolean(scheduler.enabled, `${source}.scheduler.enabled`);
  const concurrency = root.concurrency as JsonObject | undefined;
  if (concurrency?.maxOperations !== undefined) assertInteger(concurrency.maxOperations, `${source}.concurrency.maxOperations`, 1);
  return structuredClone(root) as MachineLocalConfiguration;
}

export function validateExtension(input: unknown, source: string): ConfigurationExtension {
  const root = object(input, source);
  assertKnownKeys(root, { namespace: true, version: true, config: "map" }, source);
  assertString(root.namespace, `${source}.namespace`);
  assertString(root.version, `${source}.version`);
  const namespacePattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
  if (!namespacePattern.test(root.namespace)) {
    throw new AgentWorkflowError({
      code: "CONFIG_EXTENSION_INVALID",
      message: `Extension namespace ${root.namespace} must be namespaced (for example, acme.security).`,
      path: `${source}.namespace`,
    });
  }
  return {
    namespace: root.namespace,
    version: root.version,
    config: structuredClone(object(root.config, `${source}.config`)),
  };
}

export function asFrameworkConfiguration(input: unknown): FrameworkConfiguration {
  validateConfigurationLayer(input, "effective configuration");
  return input as FrameworkConfiguration;
}
