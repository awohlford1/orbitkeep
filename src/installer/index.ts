import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeStateRoot, writeJsonAtomic } from "../storage/index.ts";
import { loadEffectiveConfiguration } from "../config/index.ts";
import { loadRoleCatalogue, renderClaude, renderCodex } from "../roles/generate.ts";
import { FRAMEWORK_VERSION } from "../version.ts";
import { recoverInterruptedTransactions, runInstallationTransaction } from "./transactions.ts";
export * from "./transactions.ts";

export interface InstallResult {
  projectRoot: string;
  created: string[];
  preserved: string[];
  legacyDetected: boolean;
  receipt: string;
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
  return [...managed, ".agent-workflow/config.json", ".agent-workflow/install-manifest.json", ".claude/settings.json", "AGENTS.md", "CLAUDE.md", ".gitignore", `${stateDirectory.replace(/[\\/]+$/, "")}/.runtime/installation.json`];
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

export const PINNED_AGENT_WORKFLOW_COMMAND = "npx --no-install agent-workflow";
const CLAUDE_HOOK_COMMAND = `${PINNED_AGENT_WORKFLOW_COMMAND} provider claude hook`;
const LEGACY_SOURCE_HOOK_COMMAND = "node packages/agent-workflow/src/cli/index.ts provider claude hook";
const CODEX_MARKER = "## Agent Workflow CLI Integration";
const CLAUDE_MARKER = "## Agent Workflow Manager Integration";
const CODEX_BLOCK_START = "<!-- agent-workflow:codex-manager:start -->";
const CODEX_BLOCK_END = "<!-- agent-workflow:codex-manager:end -->";
const CLAUDE_BLOCK_START = "<!-- agent-workflow:claude-manager:start -->";
const CLAUDE_BLOCK_END = "<!-- agent-workflow:claude-manager:end -->";
const CODEX_REFERENCE = `${CODEX_BLOCK_START}\n${CODEX_MARKER}\n\nFollow the provider-neutral manager instructions in \`.agent-workflow/codex-manager.md\`. Use the pinned Agent Workflow CLI for canonical state changes and treat provider process identifiers as provenance only.\n${CODEX_BLOCK_END}\n`;
const CLAUDE_REFERENCE = `${CLAUDE_BLOCK_START}\n${CLAUDE_MARKER}\n\nFollow the provider-neutral manager instructions in \`.agent-workflow/codex-manager.md\`. The Manager owns framework IDs and must not ask the Executive to provide them.\n${CLAUDE_BLOCK_END}\n`;

async function claudeHookTemplate(packageRoot: string): Promise<{ hooks: Record<string, unknown> }> {
  const template = await readFile(path.join(packageRoot, "integrations", "claude", "hooks.template.json"), "utf8");
  return JSON.parse(template.replaceAll("{{agentWorkflowCommand}} provider claude hook", CLAUDE_HOOK_COMMAND)) as { hooks: Record<string, unknown> };
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
  return value === LEGACY_SOURCE_HOOK_COMMAND ? CLAUDE_HOOK_COMMAND : value;
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
  if (current.includes(CODEX_MARKER)) { preserved.push(`${filename}#agent-workflow-reference`); return; }
  await writeFile(filename, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}\n${CODEX_REFERENCE}`, "utf8");
  created.push(`${filename}#agent-workflow-reference`);
}

async function installClaudeReference(filename: string, created: string[], preserved: string[]): Promise<void> {
  const current = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (current.includes(CLAUDE_MARKER)) { preserved.push(`${filename}#agent-workflow-reference`); return; }
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
  const defaultConfig = await readFile(path.join(packageRoot, "defaults", "project-config.example.json"), "utf8");
  await writeIfMissing(path.join(root, ".agent-workflow", "config.json"), defaultConfig, created, preserved);
  const effective = await loadEffectiveConfiguration({ projectRoot: root, requireProjectConfig: true });
  await mkdir(path.join(root, ".agent-workflow", "overrides"), { recursive: true });
  const hooks = await claudeHookTemplate(packageRoot);
  await installClaudeHooks(path.join(root, ".claude", "settings.json"), hooks, created, preserved);
  const codexTemplate = await readFile(path.join(packageRoot, "integrations", "codex", "MANAGER.template.md"), "utf8");
  await writeIfMissing(path.join(root, ".agent-workflow", "codex-manager.md"), codexTemplate, created, preserved);
  for (const contract of ["README.md", "MANAGER.md", "CONTRACTS.md", "ROLES.md"]) {
    await writeIfMissing(path.join(root, ".agent-workflow", "contracts", contract), await readFile(path.join(packageRoot, "contracts", contract), "utf8"), created, preserved);
  }
  for (const role of (await loadRoleCatalogue()).roles) {
    await writeIfMissing(path.join(root, ".claude", "agents", `${role.id}.md`), renderClaude(role), created, preserved);
    await writeIfMissing(path.join(root, ".codex", "agents", `${role.id}.toml`), renderCodex(role), created, preserved);
  }
  await installCodexReference(path.join(root, "AGENTS.md"), created, preserved);
  await installClaudeReference(path.join(root, "CLAUDE.md"), created, preserved);
  const ignorePath = path.join(root, ".gitignore");
  const ignore = await readFile(ignorePath, "utf8").catch(() => "");
  const state = await initializeStateRoot(root, effective.config.state.directory);
  const ignoredStateDirectory = `${path.relative(root, state.stateRoot).split(path.sep).join("/").replace(/\/+$/, "")}/`;
  if (!ignore.split(/\r?\n/).some((line) => line.trim().replace(/^\//, "") === ignoredStateDirectory)) {
    await writeFile(ignorePath, `${ignore}${ignore.endsWith("\n") || ignore === "" ? "" : "\n"}\n# Agent Workflow local runtime state\n${ignoredStateDirectory}\n`, "utf8");
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
  return { projectRoot: root, created, preserved, legacyDetected, receipt };
}

export async function installConsumer(projectRoot: string): Promise<InstallResult & { transactionId: string }> {
  const root = path.resolve(projectRoot); const stateDirectory = await installationStateDirectory(root);
  await recoverInterruptedTransactions(root, stateDirectory);
  const transaction = await runInstallationTransaction({
    projectRoot: root, stateDirectory, kind: "install", targets: await installationTargets(root, stateDirectory), toVersion: FRAMEWORK_VERSION,
    apply: () => performInstallConsumer(root),
    validate: async () => { const repair = await planRepair(root); if (!repair.safe || repair.actions.length) throw new Error(`INSTALL_VALIDATION_FAILED: ${repair.actions.map((item) => item.path).join(", ")}`); },
  });
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
  return { projectRoot: root, safe: !actions.some((action) => action.action === "manual"), actions };
}

export async function performRepairPlan(plan: RepairPlan): Promise<RepairPlan> {
  if (!plan.safe) return plan;
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url)); const expected = await expectedManagedFiles(packageRoot);
  for (const action of plan.actions) {
    const target = path.join(plan.projectRoot, action.path); const current = await readFile(target, "utf8").catch(() => undefined);
    if (action.action === "restore") { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, expected[action.path]!, "utf8"); }
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
