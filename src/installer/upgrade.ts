import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendEvent } from "../events/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { initializeStateRoot, writeJsonAtomic } from "../storage/index.ts";
import type { JsonValue } from "../storage/index.ts";
import { FRAMEWORK_VERSION } from "../version.ts";
import { expectedManagedFiles, installationStateDirectory, performRepairPlan, planRepair, recordSiloIdentityEvents, type RepairPlan } from "./index.ts";
import { ensureSiloIdentity } from "../silo/index.ts";
import { listInstallationTransactions, recoverInterruptedTransactions, rollbackInstallationTransaction, runInstallationTransaction, type InstallationTransaction } from "./transactions.ts";

export type UpgradeActionKind = "create" | "replace-managed" | "reconcile-shared" | "migrate-config" | "migrate-state" | "preserve" | "manual-conflict" | "retire";
export interface UpgradeAction { kind: UpgradeActionKind; path: string; reason: string }
export interface UpgradePlan {
  schemaVersion: "1.0"; planId: string; projectRoot: string; fromVersion?: string; toVersion: string; safe: boolean;
  migrationIds: string[]; blockedByActiveWork: string[]; stateMigrationApprovalRequired: boolean; reversible: boolean; actions: UpgradeAction[];
}

export interface FrameworkMigration { id: string; fromVersion: string; toVersion: string; reversible: boolean; migrateConfig: boolean; migrateState: boolean }
export const FRAMEWORK_MIGRATIONS: readonly FrameworkMigration[] = [
  { id: "migration-0.3.0-to-0.4.0", fromVersion: "0.3.0", toVersion: "0.4.0", reversible: true, migrateConfig: true, migrateState: true },
  { id: "migration-0.4.0-to-0.4.1", fromVersion: "0.4.0", toVersion: "0.4.1", reversible: true, migrateConfig: false, migrateState: true },
  { id: "migration-0.4.1-to-0.4.2", fromVersion: "0.4.1", toVersion: "0.4.2", reversible: true, migrateConfig: false, migrateState: true },
  { id: "migration-0.4.2-to-0.5.0", fromVersion: "0.4.2", toVersion: "0.5.0", reversible: true, migrateConfig: false, migrateState: true },
] as const;

function migrationPath(fromVersion: string, toVersion: string): FrameworkMigration[] | undefined {
  if (fromVersion === toVersion) return [];
  const path: FrameworkMigration[] = []; const visited = new Set<string>(); let cursor = fromVersion;
  while (cursor !== toVersion && !visited.has(cursor)) { visited.add(cursor); const next = FRAMEWORK_MIGRATIONS.find((item) => item.fromVersion === cursor); if (!next) return undefined; path.push(next); cursor = next.toVersion; }
  return cursor === toVersion ? path : undefined;
}

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value)?.slice(1, 4).map(Number);
  const a = parse(left); const b = parse(right); if (!a || !b) throw new Error("UPGRADE_VERSION_INVALID");
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!;
  return 0;
}

async function installationReceipt(projectRoot: string, stateDirectory: string): Promise<{ framework_version?: string } | undefined> {
  return readFile(path.join(projectRoot, stateDirectory, ".runtime", "installation.json"), "utf8").then((value) => JSON.parse(value) as { framework_version?: string }).catch(() => undefined);
}

async function activeAssignments(projectRoot: string, stateDirectory: string): Promise<string[]> {
  const root = path.join(projectRoot, stateDirectory, "assignments"); const active: string[] = [];
  for (const assignment of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!assignment.isDirectory()) continue;
    const files = await readdir(path.join(root, assignment.name, "assignment")).catch(() => []);
    for (const name of files.filter((item) => item.endsWith(".json"))) {
      try {
        const value = JSON.parse(await readFile(path.join(root, assignment.name, "assignment", name), "utf8")) as { lifecycle_state?: string; executions?: Array<{ state?: string }> };
        if (value.lifecycle_state !== "closed" || value.executions?.some((execution) => execution.state === "running" || execution.state === "unknown")) active.push(assignment.name);
      } catch { active.push(assignment.name); }
    }
  }
  return [...new Set(active)].sort();
}

export async function planUpgrade(projectRoot: string, targetVersion = FRAMEWORK_VERSION): Promise<UpgradePlan> {
  const root = path.resolve(projectRoot); const stateDirectory = await installationStateDirectory(root); const receipt = await installationReceipt(root, stateDirectory);
  const fromVersion = receipt?.framework_version; const actions: UpgradeAction[] = []; const blockedByActiveWork = await activeAssignments(root, stateDirectory); let migrations: FrameworkMigration[] = [];
  if (targetVersion !== FRAMEWORK_VERSION) actions.push({ kind: "manual-conflict", path: ".agent-workflow", reason: `Installed CLI can only apply target ${FRAMEWORK_VERSION}; requested ${targetVersion}.` });
  if (!fromVersion) actions.push({ kind: "manual-conflict", path: `${stateDirectory}/.runtime/installation.json`, reason: "Installation receipt is missing or invalid; initialize or repair before upgrading." });
  else if (compareVersions(targetVersion, fromVersion) < 0) actions.push({ kind: "manual-conflict", path: ".agent-workflow", reason: "Downgrades are not supported without a dedicated reverse migration." });
  else { const path = migrationPath(fromVersion, targetVersion); if (!path) actions.push({ kind: "manual-conflict", path: ".agent-workflow", reason: `No registered migration path exists from ${fromVersion} to ${targetVersion}.` }); else migrations = path; }

  const repair = await planRepair(root);
  for (const action of repair.actions) actions.push({
    kind: action.action === "manual" ? "manual-conflict" : action.action === "reconcile" ? "reconcile-shared" : action.reason.includes("missing") ? "create" : "replace-managed",
    path: action.path, reason: action.reason,
  });
  const changed = new Set(repair.actions.map((item) => item.path));
  for (const managed of Object.keys(await expectedManagedFiles())) if (!changed.has(managed)) actions.push({ kind: "preserve", path: managed, reason: "Canonical managed content already matches the target release." });

  const manifest = await readFile(path.join(root, ".agent-workflow", "install-manifest.json"), "utf8").then((value) => JSON.parse(value) as { managed?: Record<string, string> }).catch(() => undefined);
  const expected = await expectedManagedFiles();
  for (const [retired, recordedDigest] of Object.entries(manifest?.managed ?? {})) {
    if (retired in expected) continue;
    const content = await readFile(path.join(root, retired), "utf8").catch(() => undefined);
    actions.push(content === undefined || digest(content) === recordedDigest
      ? { kind: "retire", path: retired, reason: "The target release no longer owns this canonical file." }
      : { kind: "manual-conflict", path: retired, reason: "A retired framework file contains user changes and cannot be removed automatically." });
  }

  if (fromVersion && migrations.length) {
    const configPath = path.join(root, ".agent-workflow", "config.json");
    const config = await readFile(configPath, "utf8").then((value) => JSON.parse(value) as { retention?: { installationBackupsDays?: number } }).catch(() => undefined);
    if (migrations.some((item) => item.migrateConfig) && config?.retention && config.retention.installationBackupsDays === undefined) actions.push({ kind: "migrate-config", path: ".agent-workflow/config.json", reason: "Add the 30-day installation transaction retention default." });
    if (migrations.some((item) => item.migrateState)) actions.push({ kind: "migrate-state", path: `${stateDirectory}/.runtime/installation.json`, reason: `Advance mutable installation state from ${fromVersion} to ${targetVersion}; historical event logs remain append-only.` });
  }
  if (blockedByActiveWork.length) actions.push({ kind: "manual-conflict", path: `${stateDirectory}/assignments`, reason: "All assignments and executions must be closed before upgrading." });
  return { schemaVersion: "1.0", planId: `upl-${randomUUID()}`, projectRoot: root, ...(fromVersion ? { fromVersion } : {}), toVersion: targetVersion, safe: actions.every((item) => item.kind !== "manual-conflict"), migrationIds: migrations.map((item) => item.id), blockedByActiveWork, stateMigrationApprovalRequired: actions.some((item) => item.kind === "migrate-state"), reversible: migrations.every((item) => item.reversible), actions };
}

export async function applyUpgrade(projectRoot: string, options: { targetVersion?: string; authorizeStateMigration?: boolean } = {}): Promise<{ status: "upgraded" | "no-op"; plan: UpgradePlan; transaction?: InstallationTransaction; migrationEvidence?: string }> {
  await recoverInterruptedTransactions(projectRoot, await installationStateDirectory(projectRoot));
  const plan = await planUpgrade(projectRoot, options.targetVersion ?? FRAMEWORK_VERSION);
  if (!plan.safe) throw new Error(`UPGRADE_BLOCKED: ${plan.actions.filter((item) => item.kind === "manual-conflict").map((item) => item.reason).join("; ")}`);
  if (plan.stateMigrationApprovalRequired && options.authorizeStateMigration !== true) throw new Error("STATE_MIGRATION_APPROVAL_REQUIRED: rerun with --authorize-state-migration after reviewing the plan");
  const actionable = plan.actions.filter((item) => item.kind !== "preserve"); if (actionable.length === 0) return { status: "no-op", plan };
  const stateDirectory = await installationStateDirectory(plan.projectRoot); const migrationId = `mig-${randomUUID()}`;
  const migrationRelative = `${stateDirectory.replace(/[\\/]+$/, "")}/migrations/${migrationId}.json`;
  const targets = [...actionable.map((item) => item.path), ".agent-workflow/install-manifest.json", migrationRelative];
  const repair: RepairPlan = { projectRoot: plan.projectRoot, safe: true, actions: plan.actions.filter((item) => ["create", "replace-managed", "reconcile-shared"].includes(item.kind)).map((item) => ({ path: item.path, action: item.kind === "reconcile-shared" ? "reconcile" : "restore", reason: item.reason })) };
  const executed = await runInstallationTransaction({
    projectRoot: plan.projectRoot, stateDirectory, kind: "upgrade", targets, ...(plan.fromVersion ? { fromVersion: plan.fromVersion } : {}), toVersion: plan.toVersion,
    apply: async () => {
      const configPath = path.join(plan.projectRoot, ".agent-workflow", "config.json");
      if (plan.actions.some((item) => item.kind === "migrate-config")) { const config = JSON.parse(await readFile(configPath, "utf8")) as { retention: Record<string, unknown> }; config.retention.installationBackupsDays = 30; await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8"); }
      for (const action of plan.actions.filter((item) => item.kind === "retire")) await rm(path.join(plan.projectRoot, action.path), { force: true });
      if (repair.actions.length) await performRepairPlan(repair); else {
        const { performInstallConsumer } = await import("./index.ts"); await performInstallConsumer(plan.projectRoot);
      }
      const { stateRoot } = await initializeStateRoot(plan.projectRoot, stateDirectory);
      return writeJsonAtomic(stateRoot, path.join("migrations", `${migrationId}.json`), { schema_version: "1.0", migration_id: migrationId, from_version: plan.fromVersion ?? "unknown", to_version: plan.toVersion, applied_at: new Date().toISOString(), reversible: true, historical_events_rewritten: false } as JsonValue);
    },
    validate: async () => { const after = await planUpgrade(plan.projectRoot, plan.toVersion); if (!after.safe || after.actions.some((item) => item.kind !== "preserve")) throw new Error("UPGRADE_VALIDATION_FAILED"); },
  });
  await recordSiloIdentityEvents(plan.projectRoot, stateDirectory, await ensureSiloIdentity(plan.projectRoot, stateDirectory));
  await appendEvent({ projectRoot: plan.projectRoot, stateDirectory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: { schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: "framework.migration_completed", occurred_at: new Date().toISOString(), actor: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, data: { from_version: plan.fromVersion ?? "unknown", to_version: plan.toVersion, transaction_id: executed.transaction.transactionId } } });
  return { status: "upgraded", plan, transaction: executed.transaction, migrationEvidence: executed.result };
}

export async function upgradeStatus(projectRoot: string): Promise<{ installedVersion?: string; runtimeVersion: string; recoveryRequired: boolean; rollbackAvailable: boolean; transactions: InstallationTransaction[] }> {
  const stateDirectory = await installationStateDirectory(projectRoot); const transactions = await listInstallationTransactions(projectRoot, stateDirectory); const receipt = await installationReceipt(projectRoot, stateDirectory);
  return { ...(receipt?.framework_version ? { installedVersion: receipt.framework_version } : {}), runtimeVersion: FRAMEWORK_VERSION, recoveryRequired: transactions.some((item) => ["prepared", "applying", "rolling_back", "failed"].includes(item.status)), rollbackAvailable: transactions.some((item) => item.kind === "upgrade" && item.status === "committed"), transactions };
}

export async function rollbackUpgrade(projectRoot: string, transactionId?: string): Promise<InstallationTransaction> {
  const stateDirectory = await installationStateDirectory(projectRoot); const transactions = await listInstallationTransactions(projectRoot, stateDirectory);
  const selected = transactionId ? transactions.find((item) => item.transactionId === transactionId) : [...transactions].reverse().find((item) => item.kind === "upgrade" && item.status === "committed");
  if (!selected || selected.kind !== "upgrade") throw new Error("UPGRADE_TRANSACTION_NOT_FOUND");
  const rolledBack = await rollbackInstallationTransaction(projectRoot, stateDirectory, selected.transactionId);
  await appendEvent({ projectRoot, stateDirectory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: { schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: "framework.migration_rolled_back", occurred_at: new Date().toISOString(), actor: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, data: { from_version: selected.toVersion ?? "unknown", to_version: selected.fromVersion ?? "unknown", transaction_id: selected.transactionId } } });
  return rolledBack;
}
