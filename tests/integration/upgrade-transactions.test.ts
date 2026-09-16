import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyUpgrade, installConsumer, listInstallationTransactions, markInstallationTransactionApplying,
  planUpgrade, prepareInstallationTransaction, recoverInterruptedTransactions,
  rollbackInstallationTransaction, rollbackUpgrade, runInstallationTransaction, planInstallationTransactionCleanup, pruneInstallationTransactions,
} from "../../src/installer/index.ts";
import { doctor } from "../../src/cli/diagnostics.ts";

async function root(name: string): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), name)); await writeFile(path.join(value, "package.json"), "{}\n"); return value;
}

async function removeV05IdentityBaseline(projectRoot: string): Promise<void> {
  await rm(path.join(projectRoot, ".agent-workflow", "silo.json"), { force: true });
  await rm(path.join(projectRoot, ".agent-state", ".runtime", "silo-instance.json"), { force: true });
  await rm(path.join(projectRoot, ".agent-state", ".runtime", "event-sequence.json"), { force: true });
  await rm(path.join(projectRoot, ".agent-state", ".runtime", "event-receipts"), { recursive: true, force: true });
  await rm(path.join(projectRoot, ".agent-state", "events"), { recursive: true, force: true });
  await mkdir(path.join(projectRoot, ".agent-state", ".runtime", "event-receipts"), { recursive: true });
  await mkdir(path.join(projectRoot, ".agent-state", "events"), { recursive: true });
}

test("failed transaction validation restores every snapshotted file", async () => {
  const projectRoot = await root("aw-transaction-failure-"); const target = path.join(projectRoot, "owned.txt"); await writeFile(target, "before\n");
  await assert.rejects(runInstallationTransaction({ projectRoot, stateDirectory: ".agent-state", kind: "repair", targets: ["owned.txt", "created.txt"], apply: async () => { await writeFile(target, "after\n"); await writeFile(path.join(projectRoot, "created.txt"), "created\n"); }, validate: async () => { throw new Error("validation failed"); } }), /validation failed/);
  assert.equal(await readFile(target, "utf8"), "before\n");
  await assert.rejects(readFile(path.join(projectRoot, "created.txt")));
  assert.equal((await listInstallationTransactions(projectRoot, ".agent-state"))[0]?.status, "rolled_back");
});

test("interrupted applying transaction is recovered on demand", async () => {
  const projectRoot = await root("aw-transaction-recovery-"); const target = path.join(projectRoot, "owned.txt"); await writeFile(target, "before\n");
  const journal = await prepareInstallationTransaction({ projectRoot, stateDirectory: ".agent-state", kind: "install", targets: ["owned.txt"] });
  await markInstallationTransactionApplying(journal); await writeFile(target, "interrupted\n");
  const recovered = await recoverInterruptedTransactions(projectRoot, ".agent-state");
  assert.equal(recovered[0]?.status, "rolled_back"); assert.equal(await readFile(target, "utf8"), "before\n");
});

test("doctor blocks activation while an installation transaction is interrupted", async () => {
  const projectRoot = await root("aw-transaction-doctor-"); await installConsumer(projectRoot);
  const journal = await prepareInstallationTransaction({ projectRoot, stateDirectory: ".agent-state", kind: "repair", targets: ["AGENTS.md"] }); await markInstallationTransactionApplying(journal);
  const report = await doctor(projectRoot); assert.equal(report.activation, "blocked"); assert.equal(report.maintenance.interruptedInstallationTransactions, 1);
  await recoverInterruptedTransactions(projectRoot, ".agent-state");
});

test("doctor reports a malformed transaction journal instead of ignoring it", async () => {
  const projectRoot = await root("aw-transaction-malformed-"); await installConsumer(projectRoot);
  const malformedRoot = path.join(projectRoot, ".agent-state", "installation-transactions", "itx-malformed"); await mkdir(malformedRoot, { recursive: true }); await writeFile(path.join(malformedRoot, "journal.json"), "{broken");
  const report = await doctor(projectRoot); assert.equal(report.activation, "blocked"); assert.ok(report.errors.some((item) => item.includes("TRANSACTION_JOURNAL_INVALID")));
});

test("rollback refuses to overwrite changes made after commit", async () => {
  const projectRoot = await root("aw-transaction-conflict-"); const target = path.join(projectRoot, "owned.txt"); await writeFile(target, "before\n");
  const completed = await runInstallationTransaction({ projectRoot, stateDirectory: ".agent-state", kind: "install", targets: ["owned.txt"], apply: async () => writeFile(target, "installed\n"), validate: async () => undefined });
  await writeFile(target, "user change\n");
  await assert.rejects(rollbackInstallationTransaction(projectRoot, ".agent-state", completed.transaction.transactionId), /ROLLBACK_CONFLICT/);
  assert.equal(await readFile(target, "utf8"), "user change\n");
});

test("rollback rejects a transaction journal scoped to another project", async () => {
  const projectRoot = await root("aw-transaction-scope-"); const target = path.join(projectRoot, "owned.txt"); await writeFile(target, "before\n");
  const completed = await runInstallationTransaction({ projectRoot, stateDirectory: ".agent-state", kind: "install", targets: ["owned.txt"], apply: async () => writeFile(target, "installed\n"), validate: async () => undefined });
  const journalPath = path.join(projectRoot, ".agent-state", "installation-transactions", completed.transaction.transactionId, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")) as { projectRoot: string }; journal.projectRoot = path.dirname(projectRoot); await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await assert.rejects(rollbackInstallationTransaction(projectRoot, ".agent-state", completed.transaction.transactionId), /TRANSACTION_JOURNAL_SCOPE_MISMATCH/); assert.equal(await readFile(target, "utf8"), "installed\n");
});

test("initialization commits a recoverable installation transaction", async () => {
  const projectRoot = await root("aw-transaction-install-"); const result = await installConsumer(projectRoot);
  const journal = (await listInstallationTransactions(projectRoot, ".agent-state")).find((item) => item.transactionId === result.transactionId);
  assert.equal(journal?.kind, "install"); assert.equal(journal?.status, "committed");
});

test("upgrade is blocked while any assignment remains active", async () => {
  const projectRoot = await root("aw-upgrade-active-"); await installConsumer(projectRoot);
  const receiptPath = path.join(projectRoot, ".agent-state", ".runtime", "installation.json"); const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>; receipt.framework_version = "0.3.0"; await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const assignmentRoot = path.join(projectRoot, ".agent-state", "assignments", "asn-active", "assignment"); await mkdir(assignmentRoot, { recursive: true });
  await writeFile(path.join(assignmentRoot, "asn-active.json"), JSON.stringify({ lifecycle_state: "running", executions: [] }));
  const plan = await planUpgrade(projectRoot); assert.equal(plan.safe, false); assert.deepEqual(plan.blockedByActiveWork, ["asn-active"]);
  await assert.rejects(applyUpgrade(projectRoot, { authorizeStateMigration: true }), /UPGRADE_BLOCKED/);
});

test("authorized upgrade migrates mutable state, appends evidence, and rolls back without rewriting history", async () => {
  const projectRoot = await root("aw-upgrade-success-"); await installConsumer(projectRoot);
  await removeV05IdentityBaseline(projectRoot);
  const receiptPath = path.join(projectRoot, ".agent-state", ".runtime", "installation.json"); const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>; receipt.framework_version = "0.3.0"; await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const configPath = path.join(projectRoot, ".agent-workflow", "config.json"); const config = JSON.parse(await readFile(configPath, "utf8")) as { retention: Record<string, unknown> }; delete config.retention.installationBackupsDays; await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const eventsRoot = path.join(projectRoot, ".agent-state", "events"); const historicPath = path.join(eventsRoot, "2020-01-01.jsonl"); const historic = `${JSON.stringify({ schema_version: "1.0", event_id: "evt-historic", event_type: "decision.recorded", occurred_at: "2020-01-01T00:00:00.000Z", recorded_at: "2020-01-01T00:00:00.000Z", sequence: 1, actor: { actor_id: "manager:test", actor_type: "manager" }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, data: { record_ref: { record_type: "decision", record_id: "dec-historic" } } })}\n`; await writeFile(historicPath, historic);
  const plan = await planUpgrade(projectRoot); assert.equal(plan.safe, true); assert.equal(plan.stateMigrationApprovalRequired, true); assert.ok(plan.actions.some((item) => item.kind === "migrate-config")); assert.ok(plan.actions.some((item) => item.kind === "migrate-state"));
  assert.deepEqual(plan.migrationIds, ["migration-0.3.0-to-0.4.0", "migration-0.4.0-to-0.4.1", "migration-0.4.1-to-0.4.2", "migration-0.4.2-to-0.5.0"]);
  await assert.rejects(applyUpgrade(projectRoot), /STATE_MIGRATION_APPROVAL_REQUIRED/);
  const result = await applyUpgrade(projectRoot, { authorizeStateMigration: true }); assert.equal(result.status, "upgraded"); assert.equal(result.transaction?.status, "committed"); assert.ok(result.migrationEvidence);
  assert.equal((JSON.parse(await readFile(receiptPath, "utf8")) as { framework_version: string }).framework_version, "0.5.0");
  assert.equal((JSON.parse(await readFile(configPath, "utf8")) as { retention: { installationBackupsDays: number } }).retention.installationBackupsDays, 30);
  assert.equal(await readFile(historicPath, "utf8"), historic);
  const rolledBack = await rollbackUpgrade(projectRoot, result.transaction?.transactionId); assert.equal(rolledBack.status, "rolled_back");
  assert.equal((JSON.parse(await readFile(receiptPath, "utf8")) as { framework_version: string }).framework_version, "0.3.0"); assert.equal(await readFile(historicPath, "utf8"), historic);
});

test("0.4.0 branding migration advances metadata without renaming canonical workflow data", async () => {
  const projectRoot = await root("aw-upgrade-branding-"); await installConsumer(projectRoot);
  await removeV05IdentityBaseline(projectRoot);
  const receiptPath = path.join(projectRoot, ".agent-state", ".runtime", "installation.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.framework_version = "0.4.0";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const canonicalPath = path.join(projectRoot, ".agent-state", "events", "2020-01-02.jsonl");
  const canonical = `${JSON.stringify({ schema_version: "1.0", event_id: "evt-branding-history", event_type: "decision.recorded", occurred_at: "2020-01-02T00:00:00.000Z", recorded_at: "2020-01-02T00:00:00.000Z", sequence: 1, actor: { actor_id: "manager:test", actor_type: "manager" }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, data: { record_ref: { record_type: "decision", record_id: "dec-branding-history" } } })}\n`;
  await writeFile(canonicalPath, canonical);

  const plan = await planUpgrade(projectRoot);
  assert.equal(plan.safe, true);
  assert.equal(plan.stateMigrationApprovalRequired, true);
  assert.deepEqual(plan.migrationIds, ["migration-0.4.0-to-0.4.1", "migration-0.4.1-to-0.4.2", "migration-0.4.2-to-0.5.0"]);
  const result = await applyUpgrade(projectRoot, { authorizeStateMigration: true });
  assert.equal(result.status, "upgraded");
  assert.equal((JSON.parse(await readFile(receiptPath, "utf8")) as { framework_version: string }).framework_version, "0.5.0");
  assert.equal(await readFile(canonicalPath, "utf8"), canonical);
});

test("0.4.1 CLI UX migration updates machine integrations without rewriting history", async () => {
  const projectRoot = await root("aw-upgrade-cli-ux-"); await installConsumer(projectRoot);
  await removeV05IdentityBaseline(projectRoot);
  const receiptPath = path.join(projectRoot, ".agent-state", ".runtime", "installation.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.framework_version = "0.4.1";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  const settings = (await readFile(settingsPath, "utf8")).replaceAll('node \\".agent-workflow/providers/claude/hook.cjs\\"', "npx --no-install orbitkeep provider claude hook --json");
  await writeFile(settingsPath, settings);
  const historicPath = path.join(projectRoot, ".agent-state", "events", "2020-01-03.jsonl");
  const historic = `${JSON.stringify({ schema_version: "1.0", event_id: "evt-cli-history", event_type: "decision.recorded", occurred_at: "2020-01-03T00:00:00.000Z", recorded_at: "2020-01-03T00:00:00.000Z", sequence: 1, actor: { actor_id: "manager:test", actor_type: "manager" }, recorded_by: { actor_id: "runtime-agent-workflow", actor_type: "runtime" }, data: { record_ref: { record_type: "decision", record_id: "dec-cli-history" } } })}\n`;
  await writeFile(historicPath, historic);

  const plan = await planUpgrade(projectRoot);
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.migrationIds, ["migration-0.4.1-to-0.4.2", "migration-0.4.2-to-0.5.0"]);
  assert.ok(plan.actions.some((item) => item.path === ".claude/settings.json" && item.kind === "reconcile-shared"));
  const result = await applyUpgrade(projectRoot, { authorizeStateMigration: true });
  assert.equal(result.status, "upgraded");
  assert.match(await readFile(settingsPath, "utf8"), /node \\"\.agent-workflow\/providers\/claude\/hook\.cjs\\"/);
  assert.equal((JSON.parse(await readFile(receiptPath, "utf8")) as { framework_version: string }).framework_version, "0.5.0");
  assert.equal(await readFile(historicPath, "utf8"), historic);
});

test("upgrade refuses to guess when no registered migration path exists", async () => {
  const projectRoot = await root("aw-upgrade-unregistered-"); await installConsumer(projectRoot);
  const receiptPath = path.join(projectRoot, ".agent-state", ".runtime", "installation.json"); const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>; receipt.framework_version = "0.2.0"; await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const plan = await planUpgrade(projectRoot); assert.equal(plan.safe, false); assert.ok(plan.actions.some((item) => item.kind === "manual-conflict" && item.reason.includes("No registered migration path")));
});

test("customized retired managed files require manual resolution", async () => {
  const projectRoot = await root("aw-upgrade-retired-"); await installConsumer(projectRoot);
  const receiptPath = path.join(projectRoot, ".agent-state", ".runtime", "installation.json"); const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>; receipt.framework_version = "0.3.0"; await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const retiredPath = path.join(projectRoot, ".agent-workflow", "retired.md"); await writeFile(retiredPath, "user changed\n");
  const manifestPath = path.join(projectRoot, ".agent-workflow", "install-manifest.json"); const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { managed: Record<string, string> }; manifest.managed[".agent-workflow/retired.md"] = "sha256:not-current"; await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const plan = await planUpgrade(projectRoot); assert.equal(plan.safe, false); assert.ok(plan.actions.some((item) => item.path.endsWith("retired.md") && item.kind === "manual-conflict")); assert.equal(await readFile(retiredPath, "utf8"), "user changed\n");
});

test("completed transaction backups become cleanup-eligible after 30 days", async () => {
  const projectRoot = await root("aw-transaction-retention-"); const installed = await installConsumer(projectRoot);
  const journalPath = path.join(projectRoot, ".agent-state", "installation-transactions", installed.transactionId, "journal.json"); const journal = JSON.parse(await readFile(journalPath, "utf8")) as { updatedAt: string }; journal.updatedAt = "2020-01-01T00:00:00.000Z"; await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  assert.deepEqual(await planInstallationTransactionCleanup(projectRoot, ".agent-state", 30, new Date("2020-02-01T00:00:00.000Z")), [installed.transactionId]);
  assert.deepEqual(await pruneInstallationTransactions(projectRoot, ".agent-state", 30, new Date("2020-02-01T00:00:00.000Z")), [installed.transactionId]);
  await assert.rejects(access(path.dirname(journalPath)));
});
