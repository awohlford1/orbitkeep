import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { assertContainedStatePath, initializeStateRoot, writeJsonAtomic } from "../storage/index.ts";
import type { JsonValue } from "../storage/index.ts";

export type InstallationTransactionKind = "install" | "repair" | "upgrade" | "identity";
export type InstallationTransactionStatus = "prepared" | "applying" | "committed" | "rolling_back" | "rolled_back" | "failed";

export interface TransactionEntry {
  path: string;
  existed: boolean;
  beforeDigest?: string;
  afterDigest?: string;
}

export interface InstallationTransaction {
  schemaVersion: "1.0";
  transactionId: string;
  kind: InstallationTransactionKind;
  status: InstallationTransactionStatus;
  projectRoot: string;
  stateDirectory: string;
  createdAt: string;
  updatedAt: string;
  fromVersion?: string;
  toVersion?: string;
  entries: TransactionEntry[];
  error?: string;
}

const fileDigest = (content: Buffer) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

function safeRelative(relative: string): string {
  if (path.isAbsolute(relative) || relative === "" || relative.split(/[\\/]/).includes("..")) throw new Error(`TRANSACTION_PATH_INVALID: ${relative}`);
  return relative.split("/").join(path.sep);
}

async function currentDigest(filename: string): Promise<string | undefined> {
  try { return fileDigest(await readFile(filename)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function persist(stateRoot: string, journal: InstallationTransaction): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  await writeJsonAtomic(stateRoot, path.join("installation-transactions", journal.transactionId, "journal.json"), journal as unknown as JsonValue);
}

export async function prepareInstallationTransaction(options: {
  projectRoot: string; stateDirectory: string; kind: InstallationTransactionKind; targets: string[]; fromVersion?: string; toVersion?: string;
}): Promise<InstallationTransaction> {
  const projectRoot = path.resolve(options.projectRoot);
  const { stateRoot } = await initializeStateRoot(projectRoot, options.stateDirectory);
  const transactionId = `itx-${randomUUID()}`;
  const transactionRoot = await assertContainedStatePath(stateRoot, path.join("installation-transactions", transactionId));
  await mkdir(path.join(transactionRoot, "backup"), { recursive: true });
  const entries: TransactionEntry[] = [];
  try {
    for (const item of [...new Set(options.targets)].sort()) {
      const relative = safeRelative(item); const target = path.resolve(projectRoot, relative);
      const projectRelative = path.relative(projectRoot, target);
      if (projectRelative.startsWith(`..${path.sep}`) || projectRelative === ".." || path.isAbsolute(projectRelative)) throw new Error(`TRANSACTION_PATH_ESCAPE: ${item}`);
      const beforeDigest = await currentDigest(target);
      const entry: TransactionEntry = { path: relative.split(path.sep).join("/"), existed: beforeDigest !== undefined, ...(beforeDigest ? { beforeDigest } : {}) };
      if (entry.existed) { const backup = path.join(transactionRoot, "backup", relative); await mkdir(path.dirname(backup), { recursive: true }); await copyFile(target, backup); }
      entries.push(entry);
    }
  } catch (error) { await rm(transactionRoot, { recursive: true, force: true }); throw error; }
  const now = new Date().toISOString();
  const journal: InstallationTransaction = { schemaVersion: "1.0", transactionId, kind: options.kind, status: "prepared", projectRoot, stateDirectory: options.stateDirectory, createdAt: now, updatedAt: now, entries, ...(options.fromVersion ? { fromVersion: options.fromVersion } : {}), ...(options.toVersion ? { toVersion: options.toVersion } : {}) };
  await persist(stateRoot, journal);
  return journal;
}

export async function commitInstallationTransaction(journal: InstallationTransaction): Promise<InstallationTransaction> {
  const { stateRoot } = await initializeStateRoot(journal.projectRoot, journal.stateDirectory);
  for (const entry of journal.entries) { const after = await currentDigest(path.join(journal.projectRoot, safeRelative(entry.path))); if (after) entry.afterDigest = after; else delete entry.afterDigest; }
  journal.status = "committed"; delete journal.error; await persist(stateRoot, journal); return journal;
}

export async function markInstallationTransactionApplying(journal: InstallationTransaction): Promise<void> {
  const { stateRoot } = await initializeStateRoot(journal.projectRoot, journal.stateDirectory); journal.status = "applying"; await persist(stateRoot, journal);
}

export async function rollbackInstallationTransaction(projectRoot: string, stateDirectory: string, transactionId: string): Promise<InstallationTransaction> {
  const { stateRoot } = await initializeStateRoot(projectRoot, stateDirectory);
  const journalPath = await assertContainedStatePath(stateRoot, path.join("installation-transactions", transactionId, "journal.json"));
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as InstallationTransaction;
  if (path.resolve(journal.projectRoot) !== path.resolve(projectRoot) || journal.stateDirectory !== stateDirectory || journal.transactionId !== transactionId) throw new Error("TRANSACTION_JOURNAL_SCOPE_MISMATCH");
  if (journal.status === "rolled_back") return journal;
  if (journal.status === "committed") {
    const conflicts: string[] = [];
    for (const entry of journal.entries) if (await currentDigest(path.join(journal.projectRoot, safeRelative(entry.path))) !== entry.afterDigest) conflicts.push(entry.path);
    if (conflicts.length) throw new Error(`ROLLBACK_CONFLICT: files changed after transaction: ${conflicts.join(", ")}`);
  }
  journal.status = "rolling_back"; await persist(stateRoot, journal);
  const transactionRoot = path.dirname(journalPath);
  try {
    for (const entry of [...journal.entries].reverse()) {
      const target = path.join(journal.projectRoot, safeRelative(entry.path));
      if (entry.existed) { const backup = path.join(transactionRoot, "backup", safeRelative(entry.path)); await mkdir(path.dirname(target), { recursive: true }); await copyFile(backup, target); }
      else await rm(target, { force: true });
    }
    journal.status = "rolled_back"; await persist(stateRoot, journal); return journal;
  } catch (error) { journal.status = "failed"; journal.error = error instanceof Error ? error.message : String(error); await persist(stateRoot, journal); throw error; }
}

export async function runInstallationTransaction<T>(options: {
  projectRoot: string; stateDirectory: string; kind: InstallationTransactionKind; targets: string[]; fromVersion?: string; toVersion?: string; apply: () => Promise<T>; validate: () => Promise<void>;
}): Promise<{ result: T; transaction: InstallationTransaction }> {
  const journal = await prepareInstallationTransaction(options);
  await markInstallationTransactionApplying(journal);
  try { const result = await options.apply(); await options.validate(); return { result, transaction: await commitInstallationTransaction(journal) }; }
  catch (error) { journal.error = error instanceof Error ? error.message : String(error); await rollbackInstallationTransaction(options.projectRoot, options.stateDirectory, journal.transactionId); throw error; }
}

export async function listInstallationTransactions(projectRoot: string, stateDirectory: string): Promise<InstallationTransaction[]> {
  const { stateRoot } = await initializeStateRoot(projectRoot, stateDirectory); const root = await assertContainedStatePath(stateRoot, "installation-transactions");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []); const journals: InstallationTransaction[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const journalPath = await assertContainedStatePath(stateRoot, path.join("installation-transactions", entry.name, "journal.json"));
    try { journals.push(JSON.parse(await readFile(journalPath, "utf8")) as InstallationTransaction); }
    catch (error) { throw new Error(`TRANSACTION_JOURNAL_INVALID: ${entry.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return journals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function recoverInterruptedTransactions(projectRoot: string, stateDirectory: string): Promise<InstallationTransaction[]> {
  const recovered: InstallationTransaction[] = [];
  for (const journal of await listInstallationTransactions(projectRoot, stateDirectory)) if (["prepared", "applying", "rolling_back", "failed"].includes(journal.status)) recovered.push(await rollbackInstallationTransaction(projectRoot, stateDirectory, journal.transactionId));
  return recovered;
}

export async function pruneInstallationTransactions(projectRoot: string, stateDirectory: string, retentionDays = 30, now = new Date()): Promise<string[]> {
  const { stateRoot } = await initializeStateRoot(projectRoot, stateDirectory); const removed: string[] = [];
  for (const journal of await listInstallationTransactions(projectRoot, stateDirectory)) {
    if (!["committed", "rolled_back"].includes(journal.status) || now.getTime() - Date.parse(journal.updatedAt) < retentionDays * 86_400_000) continue;
    const root = await assertContainedStatePath(stateRoot, path.join("installation-transactions", journal.transactionId));
    const info = await stat(root); if (!info.isDirectory()) throw new Error(`TRANSACTION_CLEANUP_INVALID: ${journal.transactionId}`);
    await rm(root, { recursive: true }); removed.push(journal.transactionId);
  }
  return removed;
}

export async function planInstallationTransactionCleanup(projectRoot: string, stateDirectory: string, retentionDays = 30, now = new Date()): Promise<string[]> {
  return (await listInstallationTransactions(projectRoot, stateDirectory))
    .filter((journal) => ["committed", "rolled_back"].includes(journal.status) && now.getTime() - Date.parse(journal.updatedAt) >= retentionDays * 86_400_000)
    .map((journal) => journal.transactionId);
}
