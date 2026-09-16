import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeStateRoot, writeJsonAtomic, type JsonValue } from "../storage/index.ts";
import { loadEffectiveConfiguration } from "../config/index.ts";
import { loadRoleCatalogue, renderClaude, renderCodex } from "../roles/generate.ts";
import { FRAMEWORK_VERSION } from "../version.ts";
import { appendEvent } from "../events/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { ensureSiloIdentity, inspectSiloIdentity, replaceSiloIdentity, type SiloIdentityDerivation, type SiloIdentityInitialization } from "../silo/index.ts";
import { withOperationLock } from "../concurrency/index.ts";
import { recoverInterruptedTransactions, runInstallationTransaction } from "./transactions.ts";
export * from "./transactions.ts";

export interface InstallResult {
  projectRoot: string;
  created: string[];
  preserved: string[];
  legacyDetected: boolean;
  receipt: string;
  siloIdentity: SiloIdentityInitialization;
}
export interface RepairAction { path: string; action: "restore" | "reconcile" | "manual"; reason: string }
export interface RepairPlan { projectRoot: string; safe: boolean; actions: RepairAction[]; backupDirectory?: string }
export interface InstallPreflight { status: "ready" | "repair_required"; issues: RepairAction[] }

async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; } catch { return false; }
}
const digest = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

export async function expectedManagedFiles(packageRoot = fileURLToPath(new URL("../../", import.meta.url))): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  files[".agent-workflow/codex-manager.md"] = await readFile(path.join(packageRoot, "integrations", "codex", "MANAGER.template.md"), "utf8");
  files[".agent-workflow/providers/claude/settings.json"] = `${JSON.stringify(await claudeHookTemplate(packageRoot), null, 2)}\n`;
  for (const contract of ["README.md", "MANAGER.md", "CONTRACTS.md", "ROLES.md"]) files[`.agent-workflow/contracts/${contract}`] = await readFile(path.join(packageRoot, "contracts", contract), "utf8");
  for (const role of (await loadRoleCatalogue()).roles) {
    files[`.claude/agents/${role.id}.md`] = renderClaude(role);
    files[`.codex/agents/${role.id}.toml`] = renderCodex(role);
  }
  return files;
}

export async function installationStateDirectory(projectRoot: string): Promise<string> {
  const content = await readFile(path.join(projectRoot, ".agent-workflow", "config.json"), "utf8").catch(() => undefined);
  if (content === undefined) return ".agent-state";
  try { const value = JSON.parse(content) as { state?: { directory?: unknown } }; return typeof value.state?.directory === "string" ? value.state.directory : ".agent-state"; }
  catch { return ".agent-state"; }
}

export async function installationTargets(projectRoot: string, stateDirectory?: string): Promise<string[]> {
  stateDirectory ??= await installationStateDirectory(projectRoot);
  const managed = Object.keys(await expectedManagedFiles());
  return [...managed, ".agent-workflow/config.json", ".agent-workflow/silo.json", ".agent-workflow/install-manifest.json", ".claude/settings.json", "AGENTS.md", "CLAUDE.md", ".gitignore", `${stateDirectory.replace(/[\\/]+$/, "")}/.runtime/installation.json`, `${stateDirectory.replace(/[\\/]+$/, "")}/.runtime/silo-instance.json`];
}

export async function preflightInstall(projectRoot: string): Promise<InstallPreflight> {
  const root = path.resolve(projectRoot); const issues: RepairAction[] = [];
  const configRelative = ".agent-workflow/config.json";
  const configContent = await readFile(path.join(root, configRelative), "utf8").catch(() => undefined);
  let config: { providers?: { claude?: { enabled?: boolean } } } | undefined;
  if (configContent !== undefined) try { config = JSON.parse(configContent) as typeof config; } catch { issues.push({ path: configRelative, action: "manual", reason: `${configRelative} is not valid JSON and cannot be safely reconciled.` }); }
  if (config?.providers?.claude?.enabled !== false) {
    const relative = ".claude/settings.json"; const content = await readFile(path.join(root, relative), "utf8").catch(() => undefined);
    if (content !== undefined) try { JSON.parse(content); } catch { issues.push({ path: relative, action: "manual", reason: `${relative} is not valid JSON and cannot be safely reconciled.` }); }
  }
  const stateDirectory = await installationStateDirectory(root);
  const descriptorExists = await exists(path.join(root, ".agent-workflow", "silo.json"));
  const instanceExists = await exists(path.join(root, stateDirectory, ".runtime", "silo-instance.json"));
  const installationReceiptExists = await exists(path.join(root, stateDirectory, ".runtime", "installation.json"));
  const installedFrameworkVersion = await readFile(path.join(root, stateDirectory, ".runtime", "installation.json"), "utf8").then((value) => (JSON.parse(value) as { framework_version?: string }).framework_version).catch(() => undefined);
  if (descriptorExists || instanceExists || installationReceiptExists) {
    const identity = await inspectSiloIdentity(root, stateDirectory);
    for (const issue of identity.errors) {
      if (issue.code !== "SILO_IDENTITY_MISSING" || (issue.message.startsWith("Logical") && (instanceExists || installedFrameworkVersion === FRAMEWORK_VERSION))) issues.push({ path: ".agent-workflow/silo.json", action: "manual", reason: `${issue.code}: ${issue.message}` });
    }
  }
  return { status: issues.length === 0 ? "ready" : "repair_required", issues };
}

export async function findConsumerRoot(start = process.cwd()): Promise<string> {
  let cursor = path.resolve(start);
  while (true) {
    if (await exists(path.join(cursor, "package.json")) || await exists(path.join(cursor, ".git"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`No project root found from ${start}`);
    cursor = parent;
  }
}

async function writeIfMissing(filename: string, content: string, created: string[], preserved: string[]): Promise<void> {
  if (await exists(filename)) { preserved.push(filename); return; }
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, { encoding: "utf8", flag: "wx" });
  created.push(filename);
}

export const PINNED_AGENT_WORKFLOW_COMMAND = "npx --no-install orbitkeep";
const CLAUDE_HOOK_COMMAND = `${PINNED_AGENT_WORKFLOW_COMMAND} provider claude hook --json`;
const INTERIM_PINNED_HOOK_COMMAND = `${PINNED_AGENT_WORKFLOW_COMMAND} provider claude hook`;
const LEGACY_PINNED_HOOK_COMMAND = "npx --no-install agent-workflow provider claude hook";
const LEGACY_SOURCE_HOOK_COMMAND = "node packages/agent-workflow/src/cli/index.ts provider claude hook";
const CODEX_MARKER = "## Orbitkeep CLI Integration";
const CLAUDE_MARKER = "## Orbitkeep Flight Director Integration";
const INTERIM_CLAUDE_MARKER = "## Orbitkeep Manager Integration";
const LEGACY_CODEX_MARKER = "## Agent Workflow CLI Integration";
const LEGACY_CLAUDE_MARKER = "## Agent Workflow Manager Integration";
const CODEX_BLOCK_START = "<!-- agent-workflow:codex-manager:start -->";
const CODEX_BLOCK_END = "<!-- agent-workflow:codex-manager:end -->";
const CLAUDE_BLOCK_START = "<!-- agent-workflow:claude-manager:start -->";
const CLAUDE_BLOCK_END = "<!-- agent-workflow:claude-manager:end -->";
const CODEX_REFERENCE = `${CODEX_BLOCK_START}\n${CODEX_MARKER}\n\nFollow the provider-neutral manager instructions in \`.agent-workflow/codex-manager.md\`. Orbitkeep starts provider work headlessly and supplies the Mission binding. Never launch a provider, create the parent Mission, grant Executive approval, manually claim a lease, or inspect \`.agent-state\`. In planning mode, perform read-only discovery and return the requested structured Flight Plan. In execution mode, use the pinned Orbitkeep CLI with \`--json\` for canonical Operation, Run, Mission Report, decision, and lifecycle changes. Treat provider process identifiers as provenance only.\n${CODEX_BLOCK_END}\n`;
const CLAUDE_REFERENCE = `${CLAUDE_BLOCK_START}\n${CLAUDE_MARKER}\n\nFollow the provider-neutral Flight Director instructions in \`.agent-workflow/codex-manager.md\`. Orbitkeep starts provider work headlessly and supplies the Mission binding. Never launch a provider, create the parent Mission, grant Executive approval, manually claim a lease, inspect \`.agent-state\`, or ask the Executive for internal framework values. In planning mode, perform read-only discovery and return the requested structured Flight Plan. In execution mode, use the pinned Orbitkeep CLI with \`--json\` for canonical Operation, Run, Mission Report, decision, and lifecycle changes. A bare \`claude\` session is not an Orbitkeep Mission and is intentionally unauthorized by enforced hooks.\n${CLAUDE_BLOCK_END}\n`;

async function claudeHookTemplate(packageRoot: string): Promise<{ hooks: Record<string, unknown> }> {
  const template = await readFile(path.join(packageRoot, "integrations", "claude", "hooks.template.json"), "utf8");
  const parsed = JSON.parse(template.replaceAll("{{agentWorkflowCommand}} provider claude hook --json", CLAUDE_HOOK_COMMAND)) as { hooks: Record<string, unknown> };
  return { hooks: parsed.hooks };
}

type ManagedFileManifest = { managed?: Record<string, string> };

async function readManagedFileManifest(root: string): Promise<ManagedFileManifest | undefined> {
  return readFile(path.join(root, ".agent-workflow", "install-manifest.json"), "utf8")
    .then((text) => JSON.parse(text) as ManagedFileManifest)
    .catch(() => undefined);
}

/**
 * Framework contracts and the provider-neutral manager template are package
 * assets. A prior manifest proves that an unchanged local copy was generated
 * by Orbitkeep, so it can be advanced safely during setup. A locally changed
 * copy remains protected and causes the normal validation/repair path instead.
 */
async function writeManagedFrameworkAsset(root: string, relative: string, content: string, prior: ManagedFileManifest | undefined, created: string[], preserved: string[]): Promise<void> {
  const filename = path.join(root, relative);
  const current = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current === undefined) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content, { encoding: "utf8", flag: "wx" });
    created.push(filename);
    return;
  }
  if (current === content) { preserved.push(filename); return; }
  if (prior?.managed?.[relative] === digest(current)) {
    await writeFile(filename, content, "utf8");
    created.push(`${filename}#framework-asset-updated`);
    return;
  }
  preserved.push(filename);
}

/** Only assets with both retired-framework markers are eligible for automatic replacement. */
function isRecognizedLegacyRole(content: string): boolean {
  return content.includes("docs/agent-operations/operating-contracts/")
    && content.includes("dispatched by the Manager")
    && (content.includes("Agent Workflow") || content.includes("authoritative role and contract versions"));
}

async function writeManagedRole(filename: string, content: string, created: string[], preserved: string[]): Promise<void> {
  const current = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current === undefined) {
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content, { encoding: "utf8", flag: "wx" });
    created.push(filename);
    return;
  }
  if (current === content) { preserved.push(filename); return; }
  if (!isRecognizedLegacyRole(current)) { preserved.push(filename); return; }
  await writeFile(filename, content, "utf8");
  created.push(`${filename}#legacy-role-migrated`);
}

function hasCompleteClaudeHooks(settings: unknown, desired: { hooks: Record<string, unknown> }): boolean {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return false;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  return Object.keys(desired.hooks).every((eventName) => {
    const entries = (hooks as Record<string, unknown>)[eventName];
    return Array.isArray(entries) && entries.some((entry) => JSON.stringify(entry).includes(CLAUDE_HOOK_COMMAND));
  });
}

function replaceManagedBlock(current: string, start: string, end: string, expected: string): string | undefined {
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return undefined;
  const suffixIndex = endIndex + end.length;
  return `${current.slice(0, startIndex)}${expected}${current.slice(suffixIndex).replace(/^\r?\n/, "")}`;
}

function replaceLegacyHookCommand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replaceLegacyHookCommand);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceLegacyHookCommand(item)]));
  return value === INTERIM_PINNED_HOOK_COMMAND || value === LEGACY_SOURCE_HOOK_COMMAND || value === LEGACY_PINNED_HOOK_COMMAND ? CLAUDE_HOOK_COMMAND : value;
}

async function installClaudeHooks(filename: string, template: { hooks: Record<string, unknown> }, created: string[], preserved: string[]): Promise<void> {
  const current: Record<string, unknown> = await readFile(filename, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch((error: NodeJS.ErrnoException | SyntaxError) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot safely reconcile ${filename}: ${error.message}`);
  });
  const hooks = current.hooks === undefined ? {} : current.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) throw new Error(`Cannot safely reconcile ${filename}: hooks must be an object`);
  const mergedHooks = { ...(hooks as Record<string, unknown>) };
  let changed = false;
  for (const [eventName, desired] of Object.entries(template.hooks)) {
    const existing = mergedHooks[eventName];
    if (existing !== undefined && !Array.isArray(existing)) throw new Error(`Cannot safely reconcile ${filename}: hooks.${eventName} must be an array`);
    const entries = existing === undefined ? [] : (replaceLegacyHookCommand([...existing]) as unknown[]);
    if (existing !== undefined && JSON.stringify(entries) !== JSON.stringify(existing)) changed = true;
    const alreadyInstalled = entries.some((entry) => JSON.stringify(entry).includes(CLAUDE_HOOK_COMMAND));
    if (!alreadyInstalled) { entries.push(...desired as unknown[]); changed = true; }
    mergedHooks[eventName] = entries;
  }
  if (!changed && current.hooks !== undefined) { preserved.push(`${filename}#agent-workflow-hooks`); return; }
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify({ ...current, hooks: mergedHooks }, null, 2)}\n`, "utf8");
  created.push(`${filename}#agent-workflow-hooks`);
}

async function installCodexReference(filename: string, created: string[], preserved: string[]): Promise<void> {
  const current = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const updated = replaceManagedBlock(current, CODEX_BLOCK_START, CODEX_BLOCK_END, CODEX_REFERENCE);
  if (updated !== undefined) {
    if (updated === current) preserved.push(`${filename}#agent-workflow-reference`);
    else { await writeFile(filename, updated, "utf8"); created.push(`${filename}#agent-workflow-reference-updated`); }
    return;
  }
  if (current.includes(CODEX_MARKER) || current.includes(LEGACY_CODEX_MARKER)) { preserved.push(`${filename}#agent-workflow-reference`); return; }
  await writeFile(filename, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}\n${CODEX_REFERENCE}`, "utf8");
  created.push(`${filename}#agent-workflow-reference`);
}

async function installClaudeReference(filename: string, created: string[], preserved: string[]): Promise<void> {
  const current = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const updated = replaceManagedBlock(current, CLAUDE_BLOCK_START, CLAUDE_BLOCK_END, CLAUDE_REFERENCE);
  if (updated !== undefined) {
    if (updated === current) preserved.push(`${filename}#agent-workflow-reference`);
    else { await writeFile(filename, updated, "utf8"); created.push(`${filename}#agent-workflow-reference-updated`); }
    return;
  }
  if (current.includes(CLAUDE_MARKER) || current.includes(INTERIM_CLAUDE_MARKER) || current.includes(LEGACY_CLAUDE_MARKER)) { preserved.push(`${filename}#agent-workflow-reference`); return; }
  await writeFile(filename, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}\n${CLAUDE_REFERENCE}`, "utf8");
  created.push(`${filename}#agent-workflow-reference`);
}

export async function performInstallConsumer(projectRoot: string): Promise<InstallResult> {
  const root = path.resolve(projectRoot);
  const preflight = await preflightInstall(root);
  if (preflight.status !== "ready") throw new Error(`INSTALL_REPAIR_REQUIRED: ${preflight.issues.map((issue) => `${issue.path}: ${issue.reason}`).join("; ")}`);
  const created: string[] = [];
  const preserved: string[] = [];
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const priorManagedManifest = await readManagedFileManifest(root);
  const defaultConfig = await readFile(path.join(packageRoot, "defaults", "project-config.example.json"), "utf8");
  await writeIfMissing(path.join(root, ".agent-workflow", "config.json"), defaultConfig, created, preserved);
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  await mkdir(path.join(root, ".agent-workflow", "overrides"), { recursive: true });
  const hooks = await claudeHookTemplate(packageRoot);
  await installClaudeHooks(path.join(root, ".claude", "settings.json"), hooks, created, preserved);
  await writeManagedFrameworkAsset(root, ".agent-workflow/providers/claude/settings.json", `${JSON.stringify(hooks, null, 2)}\n`, priorManagedManifest, created, preserved);
  const codexTemplate = await readFile(path.join(packageRoot, "integrations", "codex", "MANAGER.template.md"), "utf8");
  await writeManagedFrameworkAsset(root, ".agent-workflow/codex-manager.md", codexTemplate, priorManagedManifest, created, preserved);
  for (const contract of ["README.md", "MANAGER.md", "CONTRACTS.md", "ROLES.md"]) {
    await writeManagedFrameworkAsset(root, `.agent-workflow/contracts/${contract}`, await readFile(path.join(packageRoot, "contracts", contract), "utf8"), priorManagedManifest, created, preserved);
  }
  for (const role of (await loadRoleCatalogue()).roles) {
    await writeManagedRole(path.join(root, ".claude", "agents", `${role.id}.md`), renderClaude(role), created, preserved);
    await writeManagedRole(path.join(root, ".codex", "agents", `${role.id}.toml`), renderCodex(role), created, preserved);
  }
  await installCodexReference(path.join(root, "AGENTS.md"), created, preserved);
  await installClaudeReference(path.join(root, "CLAUDE.md"), created, preserved);
  const ignorePath = path.join(root, ".gitignore");
  const ignore = await readFile(ignorePath, "utf8").catch(() => "");
  const state = await initializeStateRoot(root, effective.config.state.directory);
  const siloIdentity = await ensureSiloIdentity(root, effective.config.state.directory);
  const descriptorPath = path.join(root, ".agent-workflow", "silo.json");
  const instancePath = path.join(state.stateRoot, ".runtime", "silo-instance.json");
  (siloIdentity.descriptorCreated ? created : preserved).push(descriptorPath);
  (siloIdentity.instanceCreated ? created : preserved).push(instancePath);
  const ignoredStateDirectory = `${path.relative(root, state.stateRoot).split(path.sep).join("/").replace(/\/+$/, "")}/`;
  if (!ignore.split(/\r?\n/).some((line) => line.trim().replace(/^\//, "") === ignoredStateDirectory)) {
    await writeFile(ignorePath, `${ignore}${ignore.endsWith("\n") || ignore === "" ? "" : "\n"}\n# Orbitkeep local runtime state\n${ignoredStateDirectory}\n`, "utf8");
    created.push(`${ignorePath}#agent-workflow-entry`);
  } else preserved.push(`${ignorePath}#agent-workflow-entry`);
  const legacyDetected = await exists(path.join(state.stateRoot, "manager-ledger.json")) || await exists(path.join(root, "docs", "agent-operations", "operating-contracts"));
  const expectedFiles = await expectedManagedFiles(packageRoot);
  const manifest = Object.fromEntries(Object.entries(expectedFiles).map(([relative, content]) => [relative, digest(content)]));
  await writeFile(path.join(root, ".agent-workflow", "install-manifest.json"), `${JSON.stringify({ schemaVersion: "1.0", managed: manifest }, null, 2)}\n`, "utf8");
  const receiptRelative = path.join(".runtime", "installation.json");
  const receipt = await writeJsonAtomic(state.stateRoot, receiptRelative, {
    schema_version: "1.0", framework_version: FRAMEWORK_VERSION, installed_at: new Date().toISOString(),
    project_root: root, legacy_detected: legacyDetected, created: created.map((item) => path.relative(root, item)),
  });
  return { projectRoot: root, created, preserved, legacyDetected, receipt, siloIdentity };
}

export async function recordSiloIdentityEvents(projectRoot: string, stateDirectory: string, identity: SiloIdentityInitialization): Promise<void> {
  const runtime = { actor_id: "runtime-orbitkeep", actor_type: "runtime" as const };
  const events: Array<{ event_id: string; event_type: string; occurred_at: string; silo_id: string; silo_instance_id?: string; data: JsonValue }> = [
    {
      event_id: `evt-silo-identity-created-${identity.descriptor.silo_id.slice("silo-".length)}`,
      event_type: "silo.identity_created",
      occurred_at: identity.descriptor.created_at,
      silo_id: identity.descriptor.silo_id,
      data: { silo_id: identity.descriptor.silo_id },
    },
    {
      event_id: `evt-silo-instance-created-${identity.instance.silo_instance_id.slice("sinst-".length)}`,
      event_type: "silo.instance_created",
      occurred_at: identity.instance.created_at,
      silo_id: identity.descriptor.silo_id,
      silo_instance_id: identity.instance.silo_instance_id,
      data: { silo_id: identity.descriptor.silo_id, silo_instance_id: identity.instance.silo_instance_id },
    },
  ];
  for (const event of events) await appendEvent({
    projectRoot, stateDirectory, operationId: `op-${randomUUID()}`,
    validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event",
    event: { schema_version: "1.0", ...event, actor: runtime, recorded_by: runtime },
  });
}

async function activeMissionIds(projectRoot: string, stateDirectory: string): Promise<string[]> {
  const root = path.join(projectRoot, stateDirectory, "assignments"); const active: string[] = [];
  for (const assignment of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!assignment.isDirectory()) continue;
    for (const name of (await readdir(path.join(root, assignment.name, "assignment")).catch(() => [])).filter((item) => item.endsWith(".json"))) {
      try {
        const value = JSON.parse(await readFile(path.join(root, assignment.name, "assignment", name), "utf8")) as { lifecycle_state?: string; lifecycle?: string; executions?: Array<{ state?: string }> };
        if ((value.lifecycle_state ?? value.lifecycle) !== "closed" || value.executions?.some((execution) => ["running", "unknown"].includes(execution.state ?? ""))) active.push(assignment.name);
      } catch { active.push(assignment.name); }
    }
  }
  return [...new Set(active)].sort();
}

export async function deriveSiloConsumer(projectRoot: string): Promise<SiloIdentityDerivation & { transactionId: string }> {
  const root = path.resolve(projectRoot); const stateDirectory = await installationStateDirectory(root); const { stateRoot } = await initializeStateRoot(root, stateDirectory);
  return withOperationLock({ stateRoot, resource: "silo-identity", ownerId: `runtime-${process.pid}` }, async () => {
    await recoverInterruptedTransactions(root, stateDirectory);
    const identity = await inspectSiloIdentity(root, stateDirectory);
    if (!identity.valid) throw Object.assign(new Error(`SILO_IDENTITY_INVALID: ${identity.errors.map((item) => item.message).join("; ")}`), { code: "SILO_IDENTITY_INVALID" });
    const active = await activeMissionIds(root, stateDirectory);
    if (active.length) throw Object.assign(new Error(`SILO_DERIVATION_BLOCKED: close all Missions before deriving a new Silo identity (${active.length} active).`), { code: "SILO_DERIVATION_BLOCKED", activeMissionCount: active.length });
    if (await exists(path.join(root, stateDirectory, "registration", "receipt.json"))) throw Object.assign(new Error("SILO_DERIVATION_BLOCKED: revoke or retire the current registration before deriving a new Silo identity."), { code: "SILO_DERIVATION_BLOCKED" });
    const transaction = await runInstallationTransaction({
      projectRoot: root, stateDirectory, kind: "identity",
      targets: [".agent-workflow/silo.json", `${stateDirectory.replace(/[\\/]+$/, "")}/.runtime/silo-instance.json`],
      apply: () => replaceSiloIdentity(root, stateDirectory),
      validate: async () => {
        const after = await inspectSiloIdentity(root, stateDirectory);
        if (!after.valid || after.descriptor?.silo_id === identity.descriptor?.silo_id || after.descriptor?.derived_from_silo_id !== identity.descriptor?.silo_id) throw new Error("SILO_DERIVATION_VALIDATION_FAILED");
      },
    });
    const runtime = { actor_id: "runtime-orbitkeep", actor_type: "runtime" as const }; const derived = transaction.result;
    await appendEvent({ projectRoot: root, stateDirectory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: {
      schema_version: "1.0", event_id: `evt-silo-identity-derived-${derived.descriptor.silo_id.slice("silo-".length)}`,
      event_type: "silo.identity_derived", occurred_at: derived.descriptor.created_at, silo_id: derived.descriptor.silo_id,
      actor: runtime, recorded_by: runtime, data: { silo_id: derived.descriptor.silo_id, derived_from_silo_id: derived.previousSiloId },
    } });
    await appendEvent({ projectRoot: root, stateDirectory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: {
      schema_version: "1.0", event_id: `evt-silo-instance-created-${derived.instance.silo_instance_id.slice("sinst-".length)}`,
      event_type: "silo.instance_created", occurred_at: derived.instance.created_at, silo_id: derived.descriptor.silo_id, silo_instance_id: derived.instance.silo_instance_id,
      actor: runtime, recorded_by: runtime, data: { silo_id: derived.descriptor.silo_id, silo_instance_id: derived.instance.silo_instance_id },
    } });
    return { ...derived, transactionId: transaction.transaction.transactionId };
  });
}

export async function installConsumer(projectRoot: string): Promise<InstallResult & { transactionId: string }> {
  const root = path.resolve(projectRoot); const stateDirectory = await installationStateDirectory(root);
  await recoverInterruptedTransactions(root, stateDirectory);
  const transaction = await runInstallationTransaction({
    projectRoot: root, stateDirectory, kind: "install", targets: await installationTargets(root, stateDirectory), toVersion: FRAMEWORK_VERSION,
    apply: () => performInstallConsumer(root),
    validate: async () => { const repair = await planRepair(root); if (!repair.safe || repair.actions.length) throw new Error(`INSTALL_VALIDATION_FAILED: ${repair.actions.map((item) => item.path).join(", ")}`); },
  });
  await recordSiloIdentityEvents(root, stateDirectory, transaction.result.siloIdentity);
  return { ...transaction.result, transactionId: transaction.transaction.transactionId };
}

export async function planRepair(projectRoot: string): Promise<RepairPlan> {
  const root = path.resolve(projectRoot); const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const preflight = await preflightInstall(root); const manifest = await readFile(path.join(root, ".agent-workflow", "install-manifest.json"), "utf8").then((text) => JSON.parse(text) as { managed?: Record<string, string> }).catch(() => undefined);
  const actions: RepairPlan["actions"] = [];
  actions.push(...preflight.issues);
  if (!manifest?.managed) actions.push({ path: ".agent-workflow/install-manifest.json", action: "manual", reason: "No managed-file manifest exists; run init after resolving preflight issues." });
  else for (const [relative, content] of Object.entries(await expectedManagedFiles(packageRoot))) {
    const current = await readFile(path.join(root, relative), "utf8").catch(() => undefined);
    if (manifest.managed[relative] !== digest(content) || current === undefined || digest(current) !== digest(content)) actions.push({ path: relative, action: "restore", reason: current === undefined ? "Framework-managed file is missing." : "Framework-managed file differs from the canonical package asset." });
  }
  if (preflight.status === "ready") {
    const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true }).catch(() => undefined);
    const claudePolicy = effective?.config.providers.claude;
    if (claudePolicy?.enabled && claudePolicy.requiredMode !== "off") {
      const manager = await readFile(path.join(root, "CLAUDE.md"), "utf8").catch(() => "");
      if (!manager.includes(CLAUDE_REFERENCE)) actions.push({ path: "CLAUDE.md", action: "reconcile", reason: manager.includes(CLAUDE_BLOCK_START) ? "Claude Manager instruction block differs from the canonical package content." : "Claude Manager instructions are missing." });
      if (claudePolicy.requiredMode !== "instructions") {
        const settings = await readFile(path.join(root, ".claude", "settings.json"), "utf8").then((text) => JSON.parse(text) as unknown).catch(() => undefined);
        if (!hasCompleteClaudeHooks(settings, await claudeHookTemplate(packageRoot))) actions.push({ path: ".claude/settings.json", action: "reconcile", reason: "Claude workflow hooks are missing or incomplete." });
      }
    }
    const codexPolicy = effective?.config.providers.codex;
    if (codexPolicy?.enabled && codexPolicy.requiredMode === "instructions") {
      const manager = await readFile(path.join(root, "AGENTS.md"), "utf8").catch(() => "");
      if (!manager.includes(CODEX_REFERENCE)) actions.push({ path: "AGENTS.md", action: "reconcile", reason: manager.includes(CODEX_BLOCK_START) ? "Codex Manager instruction block differs from the canonical package content." : "Codex Manager instructions are missing." });
    }
  }
  const stateDirectory = await installationStateDirectory(root);
  const identity = await inspectSiloIdentity(root, stateDirectory);
  const installationReceipt = await readFile(path.join(root, stateDirectory, ".runtime", "installation.json"), "utf8").then((value) => JSON.parse(value) as { framework_version?: string }).catch(() => undefined);
  for (const issue of identity.errors) {
    if (issue.code === "SILO_IDENTITY_MISSING") {
      const identityPath = issue.message.startsWith("Logical") ? ".agent-workflow/silo.json" : `${stateDirectory.replace(/[\\/]+$/, "")}/.runtime/silo-instance.json`;
      const currentIdentityLost = issue.message.startsWith("Logical") && installationReceipt?.framework_version === FRAMEWORK_VERSION;
      actions.push({ path: identityPath, action: currentIdentityLost ? "manual" : "reconcile", reason: `${issue.code}: ${issue.message}${currentIdentityLost ? " Restore the tracked descriptor from version control or an authoritative backup." : ""}` });
    } else actions.push({ path: ".agent-workflow/silo.json", action: "manual", reason: `${issue.code}: ${issue.message}` });
  }
  return { projectRoot: root, safe: !actions.some((action) => action.action === "manual"), actions };
}

export async function performRepairPlan(plan: RepairPlan): Promise<RepairPlan> {
  if (!plan.safe) return plan;
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url)); const expected = await expectedManagedFiles(packageRoot);
  for (const action of plan.actions) {
    const target = path.join(plan.projectRoot, action.path); const current = await readFile(target, "utf8").catch(() => undefined);
    const siloIdentityPath = action.path === ".agent-workflow/silo.json" || action.path.endsWith("/.runtime/silo-instance.json");
    if (action.action === "restore" && !siloIdentityPath) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, expected[action.path]!, "utf8"); }
    if (action.action === "reconcile" && current !== undefined && action.path === "AGENTS.md") {
      const reconciled = replaceManagedBlock(current, CODEX_BLOCK_START, CODEX_BLOCK_END, CODEX_REFERENCE); if (reconciled !== undefined) await writeFile(target, reconciled, "utf8");
    }
    if (action.action === "reconcile" && current !== undefined && action.path === "CLAUDE.md") {
      const reconciled = replaceManagedBlock(current, CLAUDE_BLOCK_START, CLAUDE_BLOCK_END, CLAUDE_REFERENCE); if (reconciled !== undefined) await writeFile(target, reconciled, "utf8");
    }
  }
  await performInstallConsumer(plan.projectRoot); return plan;
}

export async function applyRepair(projectRoot: string): Promise<RepairPlan & { transactionId?: string }> {
  const stateDirectory = await installationStateDirectory(projectRoot); await recoverInterruptedTransactions(projectRoot, stateDirectory);
  const plan = await planRepair(projectRoot); if (!plan.safe || plan.actions.length === 0) return plan;
  const targets = [...plan.actions.filter((action) => action.action !== "manual").map((action) => action.path), ".agent-workflow/install-manifest.json", `${stateDirectory.replace(/[\\/]+$/, "")}/.runtime/installation.json`];
  const transaction = await runInstallationTransaction({
    projectRoot: plan.projectRoot, stateDirectory, kind: "repair", targets,
    apply: () => performRepairPlan(plan),
    validate: async () => { const after = await planRepair(plan.projectRoot); if (!after.safe || after.actions.length) throw new Error(`REPAIR_VALIDATION_FAILED: ${after.actions.map((item) => item.path).join(", ")}`); },
  });
  const backupDirectory = path.join(plan.projectRoot, stateDirectory, "installation-transactions", transaction.transaction.transactionId, "backup");
  return { ...transaction.result, backupDirectory, transactionId: transaction.transaction.transactionId };
}

export * from "./upgrade.ts";
