import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPortableId, writeJsonAtomic, type JsonValue } from "../storage/index.ts";

export type SessionProvider = "claude" | "codex";

export interface BrokeredSessionRecord {
  schema_version: "1.0";
  control_id: string;
  provider: SessionProvider;
  kind: "planner" | "manager" | "specialist";
  manager_instance_id: string;
  secret_digest: string;
  state: "starting" | "running" | "stopped" | "failed";
  created_at: string;
  updated_at: string;
  pid?: number;
  exit_code?: number | null;
  signal?: string | null;
  assignment_id?: string;
  task_id?: string;
  execution_id?: string;
  ownership_token?: string;
}

export interface BrokeredSessionEnvironment {
  [key: string]: string | undefined;
  ORBITKEEP_CONTROL_SESSION_ID: string;
  ORBITKEEP_SESSION_SECRET: string;
  ORBITKEEP_MANAGER_INSTANCE_ID: string;
}

const recordPath = (controlId: string) => path.join("control", "sessions", `${assertPortableId(controlId, "control session ID")}.json`);
const identityPath = (provider: SessionProvider) => path.join("control", "manager-identities", `${provider}.json`);
const digestSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

export async function resolveProviderExecutable(provider: SessionProvider, environment: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<{ executable: string; shell: boolean }> {
  const configured = environment[`ORBITKEEP_${provider.toUpperCase()}_EXECUTABLE`];
  if (configured) {
    await access(configured).catch(() => { throw Object.assign(new Error(`Configured ${provider} executable was not found: ${configured}`), { code: "PROVIDER_CLI_NOT_FOUND" }); });
    return { executable: configured, shell: platform === "win32" && /\.(?:cmd|bat)$/i.test(configured) };
  }
  if (platform !== "win32") return { executable: provider, shell: false };
  const searchPath = environment.PATH ?? environment.Path ?? "";
  const directories = searchPath.split(path.delimiter).filter(Boolean).map((directory) => directory.replace(/^"|"$/g, ""));
  // Prefer a native executable. `spawn("codex")` cannot invoke codex.ps1,
  // while npm's .cmd shim requires a shell; an installed Codex app supplies
  // codex.exe and is the least surprising launch target.
  for (const extension of [".exe", ".EXE"]) {
    for (const directory of directories) {
      const candidate = path.join(directory, `${provider}${extension}`);
      try { await access(candidate); return { executable: candidate, shell: false }; } catch { /* continue */ }
    }
  }
  for (const extension of [".cmd", ".CMD", ".bat", ".BAT"]) {
    for (const directory of directories) {
      const candidate = path.join(directory, `${provider}${extension}`);
      try { await access(candidate); return { executable: candidate, shell: true }; } catch { /* continue */ }
    }
  }
  return { executable: provider, shell: false };
}

async function writeSession(stateRoot: string, record: BrokeredSessionRecord): Promise<void> {
  await writeJsonAtomic(stateRoot, recordPath(record.control_id), record as unknown as JsonValue);
}

export async function getProviderManagerIdentity(stateRoot: string, provider: SessionProvider): Promise<string> {
  const filename = path.join(stateRoot, identityPath(provider));
  try {
    const current = JSON.parse(await readFile(filename, "utf8")) as { manager_instance_id?: unknown };
    if (typeof current.manager_instance_id === "string") return assertPortableId(current.manager_instance_id, "manager instance ID");
    throw new Error("BROKER_IDENTITY_INVALID: provider manager identity is malformed.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const managerInstanceId = `mgr-${provider}-${randomUUID()}`;
  try {
    await writeFile(filename, `${JSON.stringify({ schema_version: "1.0", manager_instance_id: managerInstanceId, provider, created_at: new Date().toISOString() })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return managerInstanceId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const current = JSON.parse(await readFile(filename, "utf8")) as { manager_instance_id?: unknown };
    if (typeof current.manager_instance_id !== "string") throw new Error("BROKER_IDENTITY_INVALID: provider manager identity is malformed.");
    return assertPortableId(current.manager_instance_id, "manager instance ID");
  }
}

export async function readBrokeredSession(stateRoot: string, controlId: string): Promise<BrokeredSessionRecord | undefined> {
  try { return JSON.parse(await readFile(path.join(stateRoot, recordPath(controlId)), "utf8")) as BrokeredSessionRecord; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function createBrokeredSession(stateRoot: string, input: {
  provider: SessionProvider;
  kind?: "planner" | "manager" | "specialist";
  managerInstanceId?: string;
  assignmentId?: string;
  taskId?: string;
  executionId?: string;
  ownershipToken?: string;
}): Promise<{ record: BrokeredSessionRecord; environment: BrokeredSessionEnvironment }> {
  const controlId = `ses-${randomUUID()}`;
  const secret = randomUUID();
  const managerInstanceId = input.managerInstanceId ?? await getProviderManagerIdentity(stateRoot, input.provider);
  assertPortableId(managerInstanceId, "manager instance ID");
  const at = new Date().toISOString();
  const record: BrokeredSessionRecord = {
    schema_version: "1.0",
    control_id: controlId,
    provider: input.provider,
    kind: input.kind ?? "manager",
    manager_instance_id: managerInstanceId,
    secret_digest: digestSecret(secret),
    state: "starting",
    created_at: at,
    updated_at: at,
    ...(input.assignmentId ? { assignment_id: assertPortableId(input.assignmentId, "assignment ID") } : {}),
    ...(input.taskId ? { task_id: assertPortableId(input.taskId, "task ID") } : {}),
    ...(input.executionId ? { execution_id: assertPortableId(input.executionId, "execution ID") } : {}),
    ...(input.ownershipToken ? { ownership_token: input.ownershipToken } : {}),
  };
  await writeSession(stateRoot, record);
  return {
    record,
    environment: {
      ORBITKEEP_CONTROL_SESSION_ID: controlId,
      ORBITKEEP_SESSION_SECRET: secret,
      ORBITKEEP_MANAGER_INSTANCE_ID: managerInstanceId,
    },
  };
}

export async function resolveBrokeredSession(stateRoot: string, environment: NodeJS.ProcessEnv): Promise<BrokeredSessionRecord | undefined> {
  const controlId = environment.ORBITKEEP_CONTROL_SESSION_ID;
  const secret = environment.ORBITKEEP_SESSION_SECRET;
  if (!controlId || !secret) return undefined;
  const record = await readBrokeredSession(stateRoot, controlId);
  if (!record || record.secret_digest !== digestSecret(secret) || record.state === "stopped" || record.state === "failed") return undefined;
  return record;
}

export async function bindBrokeredSession(stateRoot: string, environment: NodeJS.ProcessEnv, input: {
  assignmentId: string;
  ownershipToken: string;
  taskId?: string;
  executionId?: string;
}): Promise<BrokeredSessionRecord> {
  const record = await resolveBrokeredSession(stateRoot, environment);
  if (!record) throw new Error("WORKFLOW_BROKER_SESSION_REQUIRED: a valid Orbitkeep session capability is required.");
  record.assignment_id = assertPortableId(input.assignmentId, "assignment ID");
  record.ownership_token = input.ownershipToken;
  if (input.taskId) record.task_id = assertPortableId(input.taskId, "task ID");
  if (input.executionId) record.execution_id = assertPortableId(input.executionId, "execution ID");
  record.updated_at = new Date().toISOString();
  await writeSession(stateRoot, record);
  return record;
}

export async function markBrokeredSessionRunning(stateRoot: string, controlId: string, pid: number): Promise<BrokeredSessionRecord> {
  const record = await readBrokeredSession(stateRoot, controlId);
  if (!record) throw new Error(`BROKER_SESSION_NOT_FOUND: ${controlId}`);
  record.state = "running";
  record.pid = pid;
  record.updated_at = new Date().toISOString();
  await writeSession(stateRoot, record);
  return record;
}

export async function completeBrokeredSession(stateRoot: string, controlId: string, state: "stopped" | "failed", outcome: { exitCode?: number | null; signal?: string | null } = {}): Promise<BrokeredSessionRecord | undefined> {
  const record = await readBrokeredSession(stateRoot, controlId);
  if (!record) return undefined;
  record.state = state;
  if (outcome.exitCode !== undefined) record.exit_code = outcome.exitCode;
  if (outcome.signal !== undefined) record.signal = outcome.signal;
  record.updated_at = new Date().toISOString();
  delete record.ownership_token;
  await writeSession(stateRoot, record);
  return record;
}

export async function listBrokeredSessions(stateRoot: string): Promise<BrokeredSessionRecord[]> {
  const directory = path.join(stateRoot, "control", "sessions");
  const records: BrokeredSessionRecord[] = [];
  for (const name of (await readdir(directory).catch(() => [])).filter((item) => item.endsWith(".json")).sort()) {
    try { records.push(JSON.parse(await readFile(path.join(directory, name), "utf8")) as BrokeredSessionRecord); }
    catch { /* Diagnostics report malformed state; process control ignores it. */ }
  }
  return records;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function signalProcess(pid: number, mode: "graceful" | "force"): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(pid, mode === "force" ? "SIGKILL" : "SIGTERM");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const args = ["/PID", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])];
    execFile("taskkill.exe", args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

export async function interruptBrokeredSessions(stateRoot: string, assignmentId: string, mode: "graceful" | "force", timeoutMs = 5_000): Promise<Array<{ controlId: string; confirmed: boolean; reason?: string }>> {
  const active = (await listBrokeredSessions(stateRoot)).filter((record) => record.assignment_id === assignmentId && record.state === "running" && record.pid !== undefined);
  const outcomes: Array<{ controlId: string; confirmed: boolean; reason?: string }> = [];
  for (const record of active) {
    const pid = record.pid!;
    if (!processAlive(pid)) {
      await completeBrokeredSession(stateRoot, record.control_id, "stopped");
      outcomes.push({ controlId: record.control_id, confirmed: true });
      continue;
    }
    try { await signalProcess(pid, mode); }
    catch { outcomes.push({ controlId: record.control_id, confirmed: false, reason: "CONTROL_SIGNAL_FAILED" }); continue; }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && processAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
    const confirmed = !processAlive(pid);
    if (confirmed) await completeBrokeredSession(stateRoot, record.control_id, "stopped", { signal: mode === "force" ? "SIGKILL" : "SIGTERM" });
    outcomes.push({ controlId: record.control_id, confirmed, ...(confirmed ? {} : { reason: "CONTROL_TIMEOUT" }) });
  }
  return outcomes;
}

export function isBrokeredManagementOperation(input: Record<string, unknown>): boolean {
  const toolName = input.tool_name ?? input.toolName;
  if (toolName !== "Bash") return false;
  const toolInput = input.tool_input ?? input.toolInput;
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) return false;
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command !== "string" || /[\r\n]|&&|\|\||[;|<>`]|\$\(/.test(command)) return false;
  const match = /^\s*npx\s+--no-install\s+orbitkeep\s+(?:start|resume|status|ask|steer|pause|handover|ownership-acquire|transcript-record|quarantine-show)\s+--json\s+'([^']*)'(?:\s+--redact-output)?\s*$/.exec(command);
  if (!match) return false;
  try {
    const payload = JSON.parse(match[1]!) as unknown;
    return payload !== null && typeof payload === "object" && !Array.isArray(payload);
  } catch { return false; }
}

function safeDiscoveryPath(value: unknown, projectRoot?: string): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string" || /(^|[\\/])(?:\.agent-state|\.git|\.ssh|\.aws|\.config|node_modules)(?:[\\/]|$)|(^|[\\/])\.env(?:\.|$)/i.test(value)) return false;
  if (!projectRoot) return !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
  const target = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isBrokeredReadOnlyOperation(input: Record<string, unknown>, projectRoot?: string): boolean {
  const toolName = input.tool_name ?? input.toolName;
  if (toolName === "WebSearch" || toolName === "WebFetch") return true;
  if (!["Read", "Glob", "Grep", "LS"].includes(String(toolName))) return false;
  const toolInput = input.tool_input ?? input.toolInput;
  if (toolInput === null || typeof toolInput !== "object" || Array.isArray(toolInput)) return false;
  const values = toolInput as Record<string, unknown>;
  return safeDiscoveryPath(values.file_path ?? values.path, projectRoot)
    && safeDiscoveryPath(values.pattern, undefined);
}

export function isBrokeredBootstrapOperation(input: Record<string, unknown>, projectRoot?: string): boolean {
  return isBrokeredManagementOperation(input) || isBrokeredReadOnlyOperation(input, projectRoot);
}
