import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import path from "node:path";
import { completeBrokeredSession, createBrokeredSession, markBrokeredSessionRunning, resolveProviderExecutable, type BrokeredSessionRecord, type SessionProvider } from "./sessions.ts";

export type HeadlessProviderPhase = "plan" | "execute";
export type HeadlessProviderEventKind = "session_started" | "message" | "tool_started" | "tool_completed" | "result" | "usage" | "error" | "unknown";

export interface HeadlessProviderEvent {
  provider: SessionProvider;
  kind: HeadlessProviderEventKind;
  sourceType: string;
  data: Readonly<Record<string, unknown>>;
  raw: unknown;
}

export interface HeadlessProviderInvocation {
  provider: SessionProvider;
  phase: HeadlessProviderPhase;
  args: string[];
  cwd: string;
}

export interface HeadlessProviderResult {
  provider: SessionProvider;
  phase: HeadlessProviderPhase;
  controlSession: BrokeredSessionRecord;
  providerSessionId?: string;
  finalMessage: string;
  events: HeadlessProviderEvent[];
  stderr: string;
  exitCode: number;
}

export interface RunHeadlessProviderInput {
  stateRoot: string;
  projectRoot: string;
  provider: SessionProvider;
  phase: HeadlessProviderPhase;
  prompt: string;
  managerInstanceId?: string;
  assignmentId?: string;
  executionId?: string;
  ownershipToken?: string;
  onEvent?: (event: HeadlessProviderEvent) => void | Promise<void>;
  onSession?: (session: BrokeredSessionRecord) => void | Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

const MAX_STDERR_BYTES = 256 * 1024;

export function buildHeadlessProviderInvocation(provider: SessionProvider, phase: HeadlessProviderPhase, projectRoot: string): HeadlessProviderInvocation {
  const cwd = path.resolve(projectRoot);
  if (provider === "codex") {
    return {
      provider,
      phase,
      cwd,
      args: ["exec", "--json", "--color", "never", "-C", cwd, "--sandbox", phase === "plan" ? "read-only" : "workspace-write", "-"],
    };
  }
  return {
    provider,
    phase,
    cwd,
    // Execution remains governed by the installed Orbitkeep hooks. The
    // provider is never given a flag that bypasses its permission system.
    args: ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--permission-mode", phase === "plan" ? "plan" : "auto"],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = record(item);
    return block.type === "text" && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}

/** Converts either provider's JSONL protocol into the stable Orbitkeep stream. */
export function normalizeHeadlessProviderEvent(provider: SessionProvider, raw: unknown): HeadlessProviderEvent {
  const value = record(raw);
  const sourceType = String(value.type ?? value.event ?? "unknown");
  let kind: HeadlessProviderEventKind = "unknown";
  if (["system", "thread.started", "session.started"].includes(sourceType)) kind = "session_started";
  else if (["assistant", "message", "item.updated"].includes(sourceType)) kind = "message";
  else if (["item.started", "tool.started", "tool_use"].includes(sourceType)) kind = "tool_started";
  else if (["item.completed", "tool.completed", "tool_result"].includes(sourceType)) kind = "tool_completed";
  else if (["result", "turn.completed", "task.completed"].includes(sourceType)) kind = "result";
  else if (sourceType.includes("usage")) kind = "usage";
  else if (sourceType.includes("error") || value.is_error === true) kind = "error";
  return { provider, kind, sourceType, data: value, raw };
}

function eventSessionId(event: HeadlessProviderEvent): string | undefined {
  const data = event.data;
  const id = data.session_id ?? data.thread_id ?? record(data.thread).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function eventMessage(event: HeadlessProviderEvent): string {
  const data = event.data;
  if (typeof data.result === "string") return data.result;
  if (typeof data.text === "string") return data.text;
  const message = record(data.message);
  const direct = textContent(message.content ?? data.content);
  if (direct) return direct;
  const item = record(data.item);
  return typeof item.text === "string" ? item.text : textContent(item.content);
}

/** Runs a provider as a child process and keeps Orbitkeep as the user-facing control plane. */
export async function runHeadlessProvider(input: RunHeadlessProviderInput): Promise<HeadlessProviderResult> {
  if (!input.prompt.trim()) throw Object.assign(new Error("A non-empty provider prompt is required."), { code: "PROVIDER_PROMPT_REQUIRED" });
  if (input.phase === "execute" && (!input.assignmentId || !input.ownershipToken)) {
    throw Object.assign(new Error("Headless execution requires an authorized Mission assignment and ownership token."), { code: "WORKFLOW_AUTHORIZATION_REQUIRED" });
  }
  const invocation = buildHeadlessProviderInvocation(input.provider, input.phase, input.projectRoot);
  const brokered = await createBrokeredSession(input.stateRoot, {
    provider: input.provider,
    kind: input.phase === "plan" ? "planner" : "manager",
    ...(input.managerInstanceId ? { managerInstanceId: input.managerInstanceId } : {}),
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.ownershipToken ? { ownershipToken: input.ownershipToken } : {}),
  });
  const environment = { ...process.env, ...input.environment, ...brokered.environment };
  const resolved = await resolveProviderExecutable(input.provider, environment);
  const options: SpawnOptionsWithoutStdio = { cwd: invocation.cwd, env: environment, windowsHide: true, shell: resolved.shell };
  const child = spawn(resolved.executable, invocation.args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } catch (error) {
    await completeBrokeredSession(input.stateRoot, brokered.record.control_id, "failed");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`Provider CLI '${input.provider}' was not found on PATH.`), { code: "PROVIDER_CLI_NOT_FOUND" });
    throw error;
  }
  if (!child.pid) {
    await completeBrokeredSession(input.stateRoot, brokered.record.control_id, "failed");
    throw Object.assign(new Error("Provider CLI did not return a process ID."), { code: "PROVIDER_LAUNCH_FAILED" });
  }
  const runningSession = await markBrokeredSessionRunning(input.stateRoot, brokered.record.control_id, child.pid);
  await input.onSession?.(runningSession);
  child.stdin.end(input.prompt);

  const events: HeadlessProviderEvent[] = [];
  const messages: string[] = [];
  let providerSessionId: string | undefined;
  let stdoutBuffer = "";
  let stderr = "";
  let lineWork = Promise.resolve();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length); });
  child.stdout.setEncoding("utf8");
  const acceptLine = async (line: string) => {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { raw = { type: "message", text: line }; }
    const event = normalizeHeadlessProviderEvent(input.provider, raw);
    events.push(event);
    providerSessionId ??= eventSessionId(event);
    const message = eventMessage(event);
    if (message) messages.push(message);
    await input.onEvent?.(event);
  };
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) lineWork = lineWork.then(() => acceptLine(line));
  });
  const outcome = await new Promise<{ exitCode: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ exitCode: code ?? 1, signal }));
  });
  await lineWork;
  if (stdoutBuffer.trim()) await acceptLine(stdoutBuffer);
  const state = outcome.exitCode === 0 ? "stopped" : "failed";
  const completed = await completeBrokeredSession(input.stateRoot, brokered.record.control_id, state, { exitCode: outcome.exitCode, signal: outcome.signal });
  if (outcome.exitCode !== 0) {
    throw Object.assign(new Error(stderr.trim() || `${input.provider} exited with code ${outcome.exitCode}.`), { code: "PROVIDER_EXECUTION_FAILED", exitCode: outcome.exitCode });
  }
  return {
    provider: input.provider,
    phase: input.phase,
    controlSession: completed ?? brokered.record,
    ...(providerSessionId ? { providerSessionId } : {}),
    finalMessage: messages.at(-1) ?? "",
    events,
    stderr,
    exitCode: outcome.exitCode,
  };
}
