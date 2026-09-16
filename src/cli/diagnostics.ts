import { access, constants, readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEffectiveConfiguration } from "../config/index.ts";
import { CLAUDE_HOOK_COMMAND, installationStateDirectory, listInstallationTransactions, planRepair } from "../installer/index.ts";
import { CLAUDE_HOOK_EVENTS, ClaudeProviderAdapter } from "../providers/claude/index.ts";
import { CodexProviderAdapter } from "../providers/codex/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { resolveStatePaths } from "../storage/index.ts";
import { generateRoles, loadRoleCatalogue } from "../roles/generate.ts";
import { FRAMEWORK_VERSION, SUPPORTED_SCHEMA_VERSION } from "../version.ts";
import { inspectSiloIdentity, LocalFileSiloCredentialProvider, registrationReceiptErrors, type RegistrationReceipt, type RegistrationRequest, type SiloCapabilitySnapshot, type SiloConnectionObservation, type SiloHealthAssessment } from "../silo/index.ts";
import { inspectSupervisor } from "../control/supervisor.ts";
import { buildHeadlessProviderInvocation } from "../control/headless.ts";
import { resolveProviderExecutable, type SessionProvider } from "../control/sessions.ts";

export { FRAMEWORK_VERSION, SUPPORTED_SCHEMA_VERSION } from "../version.ts";

async function exists(filename: string): Promise<boolean> { try { await access(filename); return true; } catch { return false; } }
async function count(directory: string): Promise<number> { try { return (await readdir(directory)).length; } catch { return 0; } }

export async function providerCliRuntime(command: "claude" | "codex", environment: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const searchPath = environment.PATH ?? environment.Path ?? "";
  const extensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${command}${extension}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return { command, available: true };
      } catch { /* continue searching */ }
    }
  }
  return { command, available: false };
}

export interface ClaudeHookInspection { valid: boolean; missing: string[]; mismatched: string[]; additional: string[] }

function hookHandlers(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(hookHandlers);
  if (value === null || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if (typeof item.type === "string") return [item];
  return Object.values(item).flatMap(hookHandlers);
}

export async function inspectClaudeHooks(filename: string): Promise<ClaudeHookInspection> {
  const missing: string[] = []; const mismatched: string[] = []; const additional: string[] = [];
  try {
    const value = JSON.parse(await readFile(filename, "utf8")) as { hooks?: Record<string, unknown> };
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      const entries = value.hooks?.[eventName];
      const handlers = hookHandlers(entries);
      const expectedCommand = CLAUDE_HOOK_COMMAND;
      const managed = handlers.filter((handler) => handler.command === expectedCommand);
      if (!Array.isArray(entries) || managed.length === 0) missing.push(eventName);
      else if (!managed.some((handler) => handler.command === expectedCommand)) mismatched.push(eventName);
      if (handlers.some((handler) => handler.type !== "command" || handler.command !== expectedCommand)) additional.push(eventName);
    }
  } catch { missing.push(...CLAUDE_HOOK_EVENTS); }
  return { valid: missing.length === 0 && mismatched.length === 0, missing, mismatched, additional };
}

async function hasCodexIntegration(filename: string): Promise<boolean> {
  return readFile(filename, "utf8").then((text) =>
    (text.includes("Orbitkeep CLI Integration") && text.includes("pinned Orbitkeep CLI")) ||
    (text.includes("Agent Workflow CLI Integration") && text.includes("pinned Agent Workflow CLI")),
  ).catch(() => false);
}

async function hasClaudeIntegration(filename: string): Promise<boolean> {
  return readFile(filename, "utf8").then((text) =>
    text.includes("Orbitkeep Flight Director Integration") || text.includes("Orbitkeep Manager Integration") || text.includes("Agent Workflow Manager Integration"),
  ).catch(() => false);
}

type ProviderActivationStatus = "off" | "active" | "repair_required" | "unsupported";

function assessProviderActivation(provider: string, enabled: boolean, configuredMode: string | undefined, integrations: { claude: boolean; codex: boolean }, hooks: ClaudeHookInspection): { status: ProviderActivationStatus; requiredMode: string; reason: string } {
  const requiredMode = configuredMode ?? (provider === "claude" ? "enforced" : "instructions");
  if (!enabled || requiredMode === "off") return { status: "off", requiredMode: "off", reason: "The provider is not requested by project policy." };
  if (provider === "claude") {
    if (requiredMode === "brokered") return { status: "unsupported", requiredMode, reason: "Brokered Claude execution is not yet installed by the consumer bootstrap." };
    if (requiredMode === "instructions") return integrations.claude ? { status: "active", requiredMode, reason: "Claude Flight Director instructions are installed." } : { status: "repair_required", requiredMode, reason: "Claude Flight Director instructions are missing." };
    return hooks.valid ? { status: "active", requiredMode, reason: "Claude hooks meet the requested workflow mode." } : { status: "repair_required", requiredMode, reason: `Claude hooks are incomplete (missing: ${hooks.missing.join(", ") || "none"}; unpinned: ${hooks.mismatched.join(", ") || "none"}).` };
  }
  if (provider === "codex") {
    if (requiredMode !== "instructions") return { status: "unsupported", requiredMode, reason: `Codex ${requiredMode} mode is not established by Manager instructions alone.` };
    return integrations.codex ? { status: "active", requiredMode, reason: "Codex Flight Director instructions are installed." } : { status: "repair_required", requiredMode, reason: "Codex Flight Director instructions are missing." };
  }
  return { status: "unsupported", requiredMode, reason: `No installer adapter is available for provider ${provider}.` };
}

async function staleJsonCount(directory: string): Promise<number> {
  const now = Date.now(); let stale = 0;
  for (const name of await readdir(directory).catch(() => [])) {
    const filename = path.join(directory, name, name.endsWith(".lock") ? "lock.json" : "");
    try { const value = JSON.parse(await readFile(filename, "utf8")) as { expiresAt?: string }; if (value.expiresAt && Date.parse(value.expiresAt) <= now) stale += 1; }
    catch { /* malformed entries are reported by state validation */ }
  }
  return stale;
}

function semver(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
function compareVersions(left: string, right: string): number {
  const a = semver(left); const b = semver(right); if (!a || !b) return Number.NaN;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

export interface UpgradeCompatibilityInput { currentVersion?: string; targetVersion: string; configurationSchemaVersion?: string; recordSchemaVersion?: string; eventSchemaVersion?: string }
export function checkUpgradeCompatibility(input: UpgradeCompatibilityInput) {
  const currentVersion = input.currentVersion ?? FRAMEWORK_VERSION;
  const current = semver(currentVersion); const target = semver(input.targetVersion); const reasons: string[] = [];
  if (!current || !target) reasons.push("Framework versions must use semantic versioning.");
  const schemas = [input.configurationSchemaVersion, input.recordSchemaVersion, input.eventSchemaVersion].filter(Boolean);
  if (schemas.some((version) => version !== SUPPORTED_SCHEMA_VERSION)) reasons.push("One or more persisted schema versions are unsupported by this runtime.");
  const comparison = compareVersions(input.targetVersion, currentVersion);
  const migrationRequired = Boolean(current && target && current[0] !== target[0]);
  if (Number.isFinite(comparison) && comparison < 0) reasons.push("Downgrades require an explicit migration plan.");
  return { compatible: reasons.length === 0 && !migrationRequired, currentVersion, targetVersion: input.targetVersion, migrationRequired, reasons };
}

export async function capabilityReport(options: { claudeBlockingHook?: boolean; claudeWorkflowAuthorizationConnected?: boolean } = {}) {
  const claudeAdapter = new ClaudeProviderAdapter({
    blockingPreToolHook: options.claudeBlockingHook ?? false,
    workflowAuthorizationConnected: options.claudeWorkflowAuthorizationConnected ?? false,
  });
  const claude = await claudeAdapter.capabilities();
  const codex = await new CodexProviderAdapter().capabilities();
  return { controls: {
    schema_validation: { level: "enforced", reason: "The shared runtime rejects invalid canonical records." },
    state_transitions: { level: "enforced", reason: "Managed commands reject illegal transitions." },
    intent_pipeline: { level: "enforced", reason: "Managed consequential operations require durable intent." },
    local_cli_process_control: { level: "enforced", reason: "Broker-launched Codex and Claude CLI children are PID-tracked, interruptible, and require a durable receiver acknowledgement before ownership handover." },
    brokered_raw_response_capture: { level: "enforced", reason: "Broker-launched Codex and Claude CLI workers persist redacted request and response records with a linked, deduplicated response-captured event." },
    direct_shell_compliance: { level: "instructed", reason: "Provider actions outside hooks and the CLI cannot be blocked universally." },
    live_cross_provider_handover: { level: "unsupported", reason: "The broker only transfers work after the tracked process has stopped; it never transfers a live process between providers." },
  }, providers: { claude, codex }, hooks: { claude: claudeAdapter.hookCapabilities() } };
}

export async function doctor(projectRoot: string) {
  const errors: string[] = []; const warnings: string[] = []; const info: string[] = [];
  let effective;
  try { effective = await loadEffectiveConfiguration({ projectRoot, requireProjectConfig: true }); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  let stateRoot = path.join(projectRoot, ".agent-state");
  try { stateRoot = (await resolveStatePaths(projectRoot, effective?.config.state.directory)).stateRoot; } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const projectClaudeHooks = await inspectClaudeHooks(path.join(projectRoot, ".claude", "settings.json"));
  const claudeHooks = await inspectClaudeHooks(path.join(projectRoot, ".agent-workflow", "providers", "claude", "settings.json"));
  const codexIntegrated = await hasCodexIntegration(path.join(projectRoot, "AGENTS.md"));
  const claudeIntegrated = await hasClaudeIntegration(path.join(projectRoot, "CLAUDE.md"));
  const providerRuntime = {
    claude: await providerCliRuntime("claude"),
    codex: await providerCliRuntime("codex"),
  };
  if ((effective?.config.providers.claude?.enabled ?? false) && !providerRuntime.claude.available) warnings.push("Claude integration is installed, but the `claude` CLI is not available on PATH.");
  if ((effective?.config.providers.codex?.enabled ?? false) && !providerRuntime.codex.available) warnings.push("Codex integration is installed, but the `codex` CLI is not available on PATH.");
  if ((effective?.config.providers.claude?.enabled ?? false) && !claudeHooks.valid) warnings.push(`Claude hook integration is incomplete (missing: ${claudeHooks.missing.join(", ") || "none"}; unpinned: ${claudeHooks.mismatched.join(", ") || "none"}).`);
  if ((effective?.config.providers.claude?.enabled ?? false) && projectClaudeHooks.additional.length) warnings.push(`Additional project Claude hooks were detected for ${projectClaudeHooks.additional.join(", ")}. Orbitkeep Missions exclude project settings and use isolated managed hooks; bare Claude sessions remain subject to the project hooks.`);
  if ((effective?.config.providers.codex?.enabled ?? false) && !codexIntegrated) warnings.push("Codex manager instructions do not reference the pinned Orbitkeep CLI.");
  const requiredContracts = ["README.md", "MANAGER.md", "CONTRACTS.md", "ROLES.md"];
  const missingContracts = (await Promise.all(requiredContracts.map(async (name) => await exists(path.join(projectRoot, ".agent-workflow", "contracts", name)) ? undefined : name))).filter((name): name is string => name !== undefined);
  if (missingContracts.length) errors.push(`Installed workflow contracts are missing: ${missingContracts.join(", ")}.`);
  const catalogue = await loadRoleCatalogue();
  const knownRoles = new Set(catalogue.roles.map((role) => role.id));
  const configuredRoles = effective?.config.roles.enabled ?? [];
  const unknownRoles = configuredRoles.filter((role) => !knownRoles.has(role));
  if (unknownRoles.length) errors.push(`Configured roles are not in the canonical catalogue: ${unknownRoles.join(", ")}.`);
  const missingRoleAdapters: string[] = [];
  for (const role of configuredRoles) {
    if (!await exists(path.join(projectRoot, ".claude", "agents", `${role}.md`))) missingRoleAdapters.push(`.claude/agents/${role}.md`);
    if (!await exists(path.join(projectRoot, ".codex", "agents", `${role}.toml`))) missingRoleAdapters.push(`.codex/agents/${role}.toml`);
  }
  if (missingRoleAdapters.length) errors.push(`Enabled role adapters are missing: ${missingRoleAdapters.join(", ")}.`);
  const roleGeneration = await generateRoles(projectRoot, true);
  if (!roleGeneration.valid) errors.push(`Provider role adapters have drifted from the canonical catalogue: ${roleGeneration.mismatches.join(", ")}.`);
  const rawCaptureProviders = Object.entries(effective?.config.providers ?? {}).filter(([, value]) => value.captureRawResponses === true).map(([name]) => name);
  if (rawCaptureProviders.length) warnings.push(`Raw provider response capture is enabled for ${rawCaptureProviders.join(", ")}; captured data is heuristic-redacted and retained locally.`);
  const approvalPolicy = effective?.config.security.executiveApproval;
  if (approvalPolicy?.mode === "record_only") warnings.push("Executive approvals are recorded but are not cryptographically authenticated; CLI callers can self-assert executive identity.");
  if (approvalPolicy?.mode === "signed_ed25519" && Object.keys(approvalPolicy.trustedPublicKeys).length === 0) errors.push("Signed executive approval is enabled but no trusted public keys are configured.");
  const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8").catch(() => "");
  const ignoredPath = `${path.relative(projectRoot, stateRoot).split(path.sep).join("/").replace(/\/+$/, "")}/`;
  const stateRootIgnored = gitignore.split(/\r?\n/).some((line) => line.trim().replace(/^\//, "") === ignoredPath);
  if (!stateRootIgnored) errors.push(`The configured state directory ${ignoredPath} is not ignored by Git.`);
  const minimumVersion = effective?.config.framework.minimumVersion;
  if (minimumVersion && compareVersions(FRAMEWORK_VERSION, minimumVersion) < 0) errors.push(`Framework ${FRAMEWORK_VERSION} does not satisfy minimum version ${minimumVersion}.`);
  const registryComplete = coreSchemaRegistry.recordTypes().length > 0 && coreSchemaRegistry.eventTypes().length > 0;
  if (!registryComplete) errors.push("The core schema registry is incomplete.");
  const legacyDetected = await exists(path.join(stateRoot, "manager-ledger.json")) || await exists(path.join(projectRoot, "docs", "agent-operations", "operating-contracts"));
  if (legacyDetected) warnings.push("Legacy records were detected and left unchanged for Phase 2 migration.");
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const packageRelative = path.relative(projectRoot, packageRoot);
  const normalizedPackageRelative = packageRelative.split(path.sep).join("/");
  const installedFromNodeModules = normalizedPackageRelative === "node_modules/orbitkeep" || normalizedPackageRelative.startsWith("node_modules/orbitkeep/") || normalizedPackageRelative === "node_modules/@agent-workflow/cli" || normalizedPackageRelative.startsWith("node_modules/@agent-workflow/cli/");
  if (packageRelative === "" || (!packageRelative.startsWith("..") && !path.isAbsolute(packageRelative) && !installedFromNodeModules)) warnings.push("The active Orbitkeep CLI is workspace-linked and mutable; create a pinned packaged installation before treating the integration as release-ready.");
  info.push("Local ignored state is not a backup.", "Live cross-provider process takeover is unsupported.");
  const providerStatuses = Object.fromEntries(Object.entries(effective?.config.providers ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([provider, policy]) => [provider, assessProviderActivation(provider, policy.enabled, policy.requiredMode, { claude: claudeIntegrated, codex: codexIntegrated }, claudeHooks)]));
  const providerFailures = Object.values(providerStatuses).filter((item) => item.status === "repair_required" || item.status === "unsupported");
  const siloIdentity = await inspectSiloIdentity(projectRoot, effective?.config.state.directory ?? ".agent-state");
  for (const issue of siloIdentity.errors.filter((item) => item.code !== "SILO_IDENTITY_MISSING")) errors.push(`${issue.code}: ${issue.message}`);
  const keyMetadataPath = path.join(stateRoot, "registration", "keys.json");
  let keyMetadataInvalid = false;
  let keyMetadata: { active_key_id?: string; provider?: string; protection?: string; public_keys?: unknown[] } | undefined;
  if (await exists(keyMetadataPath)) {
    try {
      const candidate = JSON.parse(await readFile(keyMetadataPath, "utf8")) as typeof keyMetadata;
      const validation = coreSchemaRegistry.validateRecord("silo-key-metadata", candidate, "1.0");
      if (!validation.valid) { keyMetadataInvalid = true; errors.push(`SILO_KEY_METADATA_INVALID: ${validation.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`).join("; ")}`); }
      else keyMetadata = candidate;
    } catch { keyMetadataInvalid = true; errors.push("SILO_KEY_METADATA_INVALID: Silo key metadata contains malformed JSON."); }
  }
  const credentialAssessment = keyMetadata ? await new LocalFileSiloCredentialProvider(projectRoot, effective?.config.state.directory ?? ".agent-state").assess() : undefined;
  if (credentialAssessment?.protection === "local_file_degraded") warnings.push(...credentialAssessment.findings);
  if (credentialAssessment?.available === false) errors.push(...credentialAssessment.findings);
  const registrationRequestPath = path.join(stateRoot, "registration", "request.json"); const registrationReceiptPath = path.join(stateRoot, "registration", "receipt.json");
  let registrationRequest: RegistrationRequest | undefined; let registrationReceipt: RegistrationReceipt | undefined; let registrationInvalid = false;
  if (await exists(registrationRequestPath)) try {
    const candidate = JSON.parse(await readFile(registrationRequestPath, "utf8")) as RegistrationRequest; const validation = coreSchemaRegistry.validateRecord("silo-registration-request", candidate, "1.0");
    if (!validation.valid) { registrationInvalid = true; errors.push(`SILO_REGISTRATION_INVALID: ${validation.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`).join("; ")}`); } else registrationRequest = candidate;
  } catch { registrationInvalid = true; errors.push("SILO_REGISTRATION_INVALID: registration request contains malformed JSON."); }
  if (await exists(registrationReceiptPath)) try {
    const candidate = JSON.parse(await readFile(registrationReceiptPath, "utf8")) as RegistrationReceipt;
    const receiptErrors = registrationReceiptErrors(candidate, registrationRequest, effective?.config.silo.registration.trustedAuthorityKeys ?? {}, new Date());
    if (receiptErrors.length) { registrationInvalid = true; errors.push(`SILO_REGISTRATION_INVALID: ${receiptErrors.join("; ")}`); } else registrationReceipt = candidate;
  } catch { registrationInvalid = true; errors.push("SILO_REGISTRATION_INVALID: registration receipt contains malformed JSON."); }
  const siloPending = (await Promise.all((await readdir(path.join(stateRoot, "pending")).catch(() => [])).filter((name) => name.endsWith(".json")).map(async (name) => readFile(path.join(stateRoot, "pending", name), "utf8").then((value) => JSON.parse(value) as { silo_id?: string }).catch(() => undefined)))).some((item) => item?.silo_id === siloIdentity.descriptor?.silo_id);
  if (effective?.config.silo.registration.required && !registrationReceipt) errors.push("SILO_REGISTRATION_REQUIRED: a valid Keep registration is required by the Local Charter.");
  let lifecycleInvalid = false; let capabilitySnapshot: SiloCapabilitySnapshot | undefined; let connectionObservation: SiloConnectionObservation | undefined; let storedHealth: SiloHealthAssessment | undefined;
  for (const item of [
    { filename: "capabilities.json", recordType: "silo-capabilities", assign: (value: unknown) => { capabilitySnapshot = value as SiloCapabilitySnapshot; } },
    { filename: "connection.json", recordType: "silo-connection-observation", assign: (value: unknown) => { connectionObservation = value as SiloConnectionObservation; } },
    { filename: "health.json", recordType: "silo-health-assessment", assign: (value: unknown) => { storedHealth = value as SiloHealthAssessment; } },
  ] as const) {
    const filename = path.join(stateRoot, "registration", item.filename); if (!await exists(filename)) continue;
    try {
      const candidate = JSON.parse(await readFile(filename, "utf8")) as { silo_id?: string; silo_instance_id?: string };
      const validation = coreSchemaRegistry.validateRecord(item.recordType, candidate, "1.0");
      if (!validation.valid || candidate.silo_id !== siloIdentity.descriptor?.silo_id || candidate.silo_instance_id !== siloIdentity.instance?.silo_instance_id) { lifecycleInvalid = true; errors.push(`SILO_LIFECYCLE_INVALID: ${item.filename} is invalid or bound to another Silo instance.`); }
      else item.assign(candidate);
    } catch { lifecycleInvalid = true; errors.push(`SILO_LIFECYCLE_INVALID: ${item.filename} contains malformed JSON.`); }
  }
  let observedConnectivity = connectionObservation?.state ?? "offline";
  if (observedConnectivity === "connected" && Date.parse(connectionObservation?.valid_until ?? "") <= Date.now()) { observedConnectivity = "disconnected"; warnings.push("The last connected observation exceeded its liveness window and is now treated as disconnected."); }
  const managedRepair = await planRepair(projectRoot);
  if (!managedRepair.safe) errors.push(`Manual repair is required: ${managedRepair.actions.filter((item) => item.action === "manual").map((item) => item.reason).join("; ")}`);
  let installationTransactions: Awaited<ReturnType<typeof listInstallationTransactions>> = [];
  try { installationTransactions = await listInstallationTransactions(projectRoot, await installationStateDirectory(projectRoot)); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const interruptedTransactions = installationTransactions.filter((item) => ["prepared", "applying", "rolling_back", "failed"].includes(item.status));
  if (interruptedTransactions.length) errors.push(`Interrupted installation transactions require recovery: ${interruptedTransactions.map((item) => item.transactionId).join(", ")}.`);
  const activation = errors.length > 0 ? "blocked" : managedRepair.actions.length > 0 || providerFailures.some((item) => item.status === "repair_required") ? "repair_required" : providerFailures.length > 0 ? "blocked" : Object.values(providerStatuses).some((item) => item.status === "active") ? "active" : "active_limited";
  const siloHealth = !managedRepair.safe || keyMetadataInvalid || registrationInvalid || lifecycleInvalid || storedHealth?.state === "blocked" || (effective?.config.silo.registration.required && !registrationReceipt) || credentialAssessment?.available === false || siloIdentity.errors.some((item) => item.code !== "SILO_IDENTITY_MISSING") ? "blocked" : credentialAssessment?.protection === "local_file_degraded" || storedHealth?.state === "degraded" ? "degraded" : siloIdentity.valid ? "healthy" : "degraded";
  const administrativeState = registrationReceipt ? "registered" : siloPending ? "registration_pending" : "unregistered";
  const silo = {
    identity: { valid: siloIdentity.valid, ...(siloIdentity.descriptor ? { siloId: siloIdentity.descriptor.silo_id, identityVersion: siloIdentity.descriptor.identity_version, originHint: siloIdentity.descriptor.origin_hint } : {}), ...(siloIdentity.instance ? { siloInstanceId: siloIdentity.instance.silo_instance_id, instanceVersion: siloIdentity.instance.instance_version } : {}), errors: siloIdentity.errors },
    administrativeState, connectivityState: observedConnectivity, healthState: siloHealth,
    membership: registrationReceipt ? { registrationId: registrationReceipt.registration_id, keepId: registrationReceipt.keep_id, ...(registrationReceipt.colony_id ? { colonyId: registrationReceipt.colony_id } : {}), revalidateAt: registrationReceipt.revalidate_at } : undefined,
    credential: keyMetadata ? { provider: keyMetadata.provider, protection: credentialAssessment?.protection ?? keyMetadata.protection, activeKeyId: keyMetadata.active_key_id, publicKeyCount: keyMetadata.public_keys?.length ?? 0, available: credentialAssessment?.available ?? false, findings: credentialAssessment?.findings ?? [] } : { configured: false },
    capabilities: capabilitySnapshot ? { values: capabilitySnapshot.capabilities, digest: capabilitySnapshot.digest, observedAt: capabilitySnapshot.observed_at } : undefined,
    latestHealthAssessment: storedHealth ? { state: storedHealth.state, assessedAt: storedHealth.assessed_at, findings: storedHealth.findings } : undefined,
    latestConnectionObservation: connectionObservation ? { state: connectionObservation.state, observedAt: connectionObservation.observed_at, validUntil: connectionObservation.valid_until, reason: connectionObservation.reason } : undefined,
    displayState: siloHealth === "blocked" ? "blocked" : siloHealth === "degraded" ? "degraded" : observedConnectivity === "connected" ? "connected" : observedConnectivity === "disconnected" ? "disconnected" : administrativeState,
  };
  const capabilities = await capabilityReport({ claudeBlockingHook: claudeHooks.valid, claudeWorkflowAuthorizationConnected: claudeHooks.valid });
  const supervisor = await inspectSupervisor(stateRoot);
  return {
    healthy: activation === "active" || activation === "active_limited", frameworkVersion: FRAMEWORK_VERSION, configurationSchemaVersion: SUPPORTED_SCHEMA_VERSION, recordSchemaVersion: SUPPORTED_SCHEMA_VERSION, eventSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    configurationDigest: effective?.digest, stateRoot, stateRootSafety: { contained: !path.relative(projectRoot, stateRoot).startsWith(".."), gitignored: stateRootIgnored, ignoredPath },
    enabledProviders: Object.entries(effective?.config.providers ?? {}).filter(([, value]) => value.enabled).map(([name]) => name).sort(),
    activation, silo, supervisor, providerActivation: providerStatuses, providerRuntime, repair: managedRepair, integrations: { claude: claudeHooks.valid, codex: codexIntegrated }, hookInspection: { claude: claudeHooks, claudeProject: projectClaudeHooks }, missionIsolation: { claude: { enabled: claudeHooks.valid, settingSources: [], settingsPath: ".agent-workflow/providers/claude/settings.json" } }, capabilities,
    contracts: { valid: missingContracts.length === 0, missing: missingContracts },
    roles: { valid: unknownRoles.length === 0 && missingRoleAdapters.length === 0 && roleGeneration.valid, configured: configuredRoles, unknown: unknownRoles, missingAdapters: missingRoleAdapters, drift: roleGeneration.mismatches },
    schemas: { registryComplete, recordTypes: coreSchemaRegistry.recordTypes().length, eventTypes: coreSchemaRegistry.eventTypes().length, extensions: Object.keys(effective?.extensions ?? {}) },
    counts: { pending: await count(path.join(stateRoot, "pending")), quarantine: await count(path.join(stateRoot, "quarantine")), awaitingValidation: await count(path.join(stateRoot, "awaiting-validation")) },
    stale: { operationLocks: await staleJsonCount(path.join(stateRoot, "locks", "operations")), ownershipLeases: await staleJsonCount(path.join(stateRoot, "locks", "ownership")) },
    maintenance: { cleanupOperations: await count(path.join(stateRoot, "cleanup", ".operations")), archiveOperations: await count(path.join(stateRoot, "archive", ".operations")), installationTransactions: installationTransactions.length, interruptedInstallationTransactions: interruptedTransactions.length },
    legacyDetected, errors, warnings, info,
  };
}

export async function validateInstallation(projectRoot: string) {
  const report = await doctor(projectRoot);
  return { valid: report.healthy && report.activation !== "blocked" && report.activation !== "repair_required" && report.contracts.valid && report.roles.valid && report.silo.identity.valid, activation: report.activation, silo: report.silo, providerActivation: report.providerActivation, configurationDigest: report.configurationDigest, integration: { claude: report.integrations.claude, codex: report.integrations.codex }, errors: report.errors, warnings: report.warnings, schemas: report.schemas, contracts: report.contracts, roles: report.roles };
}

async function providerAuthentication(provider: SessionProvider, environment: NodeJS.ProcessEnv): Promise<{ state: "authenticated" | "unauthenticated" | "unavailable" | "unknown"; reason: string }> {
  let resolved: Awaited<ReturnType<typeof resolveProviderExecutable>>;
  try { resolved = await resolveProviderExecutable(provider, environment); }
  catch { return { state: "unavailable", reason: `The ${provider} CLI executable could not be resolved.` }; }
  const args = provider === "claude" ? ["auth", "status", "--json"] : ["login", "status"];
  return new Promise((resolve) => {
    const child = spawn(resolved.executable, args, { env: environment, windowsHide: true, shell: resolved.shell, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let settled = false;
    const finish = (value: { state: "authenticated" | "unauthenticated" | "unavailable" | "unknown"; reason: string }) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish({ state: "unknown", reason: "The authentication status probe timed out." }); }, 5_000);
    timer.unref();
    child.stdout?.setEncoding("utf8"); child.stdout?.on("data", (chunk: string) => { if (stdout.length < 64 * 1024) stdout += chunk.slice(0, 64 * 1024 - stdout.length); });
    child.once("error", () => finish({ state: "unavailable", reason: `The ${provider} authentication status command could not start.` }));
    child.once("close", (code) => {
      if (provider === "claude") {
        try {
          const status = JSON.parse(stdout) as { loggedIn?: unknown };
          finish(status.loggedIn === true
            ? { state: "authenticated", reason: "Claude reports an authenticated local session." }
            : { state: "unauthenticated", reason: "Claude reports that no authenticated local session is active." });
        } catch { finish({ state: code === 0 ? "unknown" : "unauthenticated", reason: "Claude did not return a parseable authentication status." }); }
        return;
      }
      finish(code === 0
        ? { state: "authenticated", reason: "Codex reports an authenticated local session." }
        : { state: "unauthenticated", reason: "Codex did not confirm an authenticated local session." });
    });
  });
}

async function providerHeadlessCompatibility(provider: SessionProvider, environment: NodeJS.ProcessEnv): Promise<{ supported: boolean; reason: string }> {
  let resolved: Awaited<ReturnType<typeof resolveProviderExecutable>>;
  try { resolved = await resolveProviderExecutable(provider, environment); }
  catch { return { supported: false, reason: `The ${provider} CLI executable could not be resolved.` }; }
  const args = provider === "claude" ? ["--help"] : ["exec", "--help"];
  return new Promise((resolve) => {
    const child = spawn(resolved.executable, args, { env: environment, windowsHide: true, shell: resolved.shell, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let settled = false;
    const finish = (value: { supported: boolean; reason: string }) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish({ supported: false, reason: `The ${provider} headless capability probe timed out.` }); }, 5_000);
    timer.unref();
    const capture = (chunk: string) => { if (output.length < 128 * 1024) output += chunk.slice(0, 128 * 1024 - output.length); };
    child.stdout?.setEncoding("utf8"); child.stdout?.on("data", capture);
    child.stderr?.setEncoding("utf8"); child.stderr?.on("data", capture);
    child.once("error", () => finish({ supported: false, reason: `The ${provider} headless capability probe could not start.` }));
    child.once("close", (code) => {
      const required = provider === "claude" ? ["--setting-sources", "--settings", "--output-format"] : ["--json", "--sandbox"];
      const missing = required.filter((flag) => !output.includes(flag));
      finish(code === 0 && missing.length === 0
        ? { supported: true, reason: `The installed ${provider} CLI exposes Orbitkeep's required headless options.` }
        : { supported: false, reason: code !== 0 ? `The ${provider} headless capability probe exited with code ${code}.` : `The installed ${provider} CLI is missing required options: ${missing.join(", ")}.` });
    });
  });
}

export async function providerDoctor(projectRoot: string, provider: SessionProvider, environment: NodeJS.ProcessEnv = process.env) {
  const effective = await loadEffectiveConfiguration({ projectRoot, requireProjectConfig: true });
  const projectHooks = await inspectClaudeHooks(path.join(projectRoot, ".claude", "settings.json"));
  const hooks = await inspectClaudeHooks(path.join(projectRoot, ".agent-workflow", "providers", "claude", "settings.json"));
  const integrations = { claude: await hasClaudeIntegration(path.join(projectRoot, "CLAUDE.md")), codex: await hasCodexIntegration(path.join(projectRoot, "AGENTS.md")) };
  const policy = effective.config.providers[provider];
  const activation = assessProviderActivation(provider, policy?.enabled ?? false, policy?.requiredMode, integrations, hooks);
  let executableAvailable = true;
  try { await resolveProviderExecutable(provider, environment); } catch { executableAvailable = false; }
  if (executableAvailable) executableAvailable = (await providerCliRuntime(provider, environment)).available || Boolean(environment[`ORBITKEEP_${provider.toUpperCase()}_EXECUTABLE`]);
  const authentication = executableAvailable ? await providerAuthentication(provider, environment) : { state: "unavailable" as const, reason: `The ${provider} CLI is not available.` };
  const headlessCompatibility = executableAvailable ? await providerHeadlessCompatibility(provider, environment) : { supported: false, reason: `The ${provider} CLI is not available.` };
  const capabilities = await capabilityReport({ claudeBlockingHook: hooks.valid, claudeWorkflowAuthorizationConnected: hooks.valid });
  const permissionControl = provider === "claude"
    ? { state: hooks.valid ? "enforced" : "repair_required", reason: hooks.valid ? "Claude blocking hooks are installed and connected to workflow authorization." : "Claude blocking hooks are incomplete." }
    : { state: integrations.codex ? "instructed" : "repair_required", reason: integrations.codex ? "Codex Flight Director instructions are installed; native universal tool blocking is not claimed." : "Codex Flight Director instructions are missing." };
  const invocation = buildHeadlessProviderInvocation(provider, "execute", projectRoot);
  const ready = activation.status === "active" && executableAvailable && authentication.state === "authenticated" && headlessCompatibility.supported && permissionControl.state !== "repair_required";
  return {
    status: ready ? "ready" : "attention_required", provider, activation,
    runtime: { available: executableAvailable }, authentication,
    headlessExecution: { supported: headlessCompatibility.supported, reason: headlessCompatibility.reason, transport: "jsonl", mode: provider === "claude" ? "print" : "exec", workingDirectory: invocation.cwd, ...(provider === "claude" ? { isolatedSettings: hooks.valid, additionalProjectHookEvents: projectHooks.additional } : {}) },
    eventStreaming: { supported: true, normalized: true }, permissionControl,
    capabilities: capabilities.providers[provider],
  };
}
