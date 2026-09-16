import { appendFile, chmod, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactRawResponse, persistRedactedRawResponse } from "../providers/raw-responses.ts";
import { assertContainedStatePath, assertPortableId } from "../storage/layout.ts";
import { writeJsonAtomic } from "../storage/atomic.ts";
import type { JsonValue } from "../storage/types.ts";
import { renewOwnershipLease } from "../concurrency/leases.ts";
import { WorkflowCommandService, StateWorkflowRepository, type CommandContext } from "../commands/index.ts";
import { loadEffectiveConfiguration } from "../config/index.ts";
import { captureGitWorkspaceSnapshot } from "../evidence/index.ts";
import { runHeadlessProvider, type HeadlessProviderEvent } from "./headless.ts";
import { interruptBrokeredSessions, readBrokeredSession, type BrokeredSessionRecord, type SessionProvider } from "./sessions.ts";

export type SupervisorJobState = "queued" | "starting" | "running" | "completed" | "failed" | "interrupted";
export interface SupervisorJobRecord {
  schema_version: "1.0";
  job_id: string;
  assignment_id: string;
  provider: SessionProvider;
  phase: "execute";
  state: SupervisorJobState;
  source_event: string;
  manager_instance_id: string;
  task_id: string;
  execution_id: string;
  created_at: string;
  updated_at: string;
  control_session_id?: string;
  provider_session_id?: string;
  pid?: number;
  event_count: number;
  response_id?: string;
  result_id?: string;
  error?: { code: string; message: string };
}

interface LaunchRequest {
  action: "launch";
  projectRoot: string;
  provider: SessionProvider;
  prompt: string;
  managerInstanceId: string;
  assignmentId: string;
  taskId: string;
  executionId: string;
  ownershipToken: string;
  sourceEvent: string;
  retentionDays: number;
  idleTimeoutMs: number;
}
type SupervisorBody = LaunchRequest | { action: "ping" } | { action: "list"; assignmentId?: string } | { action: "status"; jobId: string } | { action: "shutdown"; force: boolean; timeoutMs: number };
type SupervisorRequest = { token: string } & SupervisorBody;
type SupervisorResponse = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };

const relativeRoot = path.join("control", "supervisor");
const authRelativePath = path.join(relativeRoot, "auth.json");
const recordRelativePath = path.join(relativeRoot, "supervisor.json");
const jobRelativePath = (jobId: string) => path.join(relativeRoot, "jobs", `${assertPortableId(jobId, "supervisor job ID")}.json`);
const jobLogRelativePath = (jobId: string) => path.join(relativeRoot, "logs", `${assertPortableId(jobId, "supervisor job ID")}.jsonl`);
const DEFAULT_EVENT_LIMIT = 200;

function endpointFor(stateRoot: string): string {
  const digest = createHash("sha256").update(path.resolve(stateRoot).toLowerCase()).digest("hex").slice(0, 24);
  // macOS limits Unix-domain socket paths to roughly 104 bytes. A Silo can
  // live under an arbitrarily deep checkout, so keep the endpoint short and
  // bind it to the state root through a collision-resistant digest.
  return process.platform === "win32" ? `\\\\.\\pipe\\orbitkeep-${digest}` : path.join(tmpdir(), `orbitkeep-${digest}.sock`);
}

async function readJson<T>(pathname: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(pathname, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function ensureAuth(stateRoot: string): Promise<string> {
  const pathname = await assertContainedStatePath(stateRoot, authRelativePath);
  await mkdir(path.dirname(pathname), { recursive: true });
  const existing = await readJson<{ token?: string }>(pathname);
  if (existing?.token) return existing.token;
  const token = randomBytes(32).toString("base64url");
  const handle = await open(pathname, "wx", 0o600).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return undefined;
  });
  if (handle) {
    try { await handle.writeFile(`${JSON.stringify({ version: "1.0", token })}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    if (process.platform !== "win32") await chmod(pathname, 0o600);
    return token;
  }
  const raced = await readJson<{ token?: string }>(pathname);
  if (!raced?.token) throw new Error("Supervisor authentication could not be initialized.");
  return raced.token;
}

function authorized(actual: string, supplied: string): boolean {
  const a = Buffer.from(actual); const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function requestWithToken(stateRoot: string, token: string, body: SupervisorBody, timeoutMs = 5_000): Promise<unknown> {
  const endpoint = endpointFor(stateRoot);
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("Orbitkeep supervisor did not respond."), { code: "SUPERVISOR_TIMEOUT" })); }, timeoutMs);
    socket.setEncoding("utf8");
    // Keep the client side open until the response arrives. Windows named
    // pipes do not reliably support the Unix-style half-close request pattern.
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...body, token })}\n`));
    socket.on("data", (chunk) => { buffer += chunk; });
    socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
    socket.once("close", () => {
      clearTimeout(timeout);
      try {
        const response = JSON.parse(buffer) as SupervisorResponse;
        if (!response.ok) reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
        else resolve(response.value);
      } catch (error) { reject(error); }
    });
  });
}

async function request(stateRoot: string, body: SupervisorBody, timeoutMs = 5_000): Promise<unknown> {
  return requestWithToken(stateRoot, await ensureAuth(stateRoot), body, timeoutMs);
}

async function writeJob(stateRoot: string, job: SupervisorJobRecord): Promise<void> {
  await writeJsonAtomic(stateRoot, jobRelativePath(job.job_id), job as unknown as JsonValue);
}

async function readJob(stateRoot: string, jobId: string): Promise<SupervisorJobRecord | undefined> {
  return readJson<SupervisorJobRecord>(await assertContainedStatePath(stateRoot, jobRelativePath(jobId)));
}

async function appendJobEvent(stateRoot: string, jobId: string, event: Record<string, unknown>): Promise<void> {
  const filename = await assertContainedStatePath(stateRoot, jobLogRelativePath(jobId));
  await mkdir(path.dirname(filename), { recursive: true });
  await appendFile(filename, `${JSON.stringify(redactRawResponse(event))}\n`, "utf8");
}

async function listJobs(stateRoot: string, assignmentId?: string): Promise<SupervisorJobRecord[]> {
  const directory = await assertContainedStatePath(stateRoot, path.join(relativeRoot, "jobs"));
  await mkdir(directory, { recursive: true });
  const names = await readdir(directory);
  const jobs = (await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson<SupervisorJobRecord>(path.join(directory, name))))).filter((job): job is SupervisorJobRecord => Boolean(job));
  return jobs.filter((job) => !assignmentId || job.assignment_id === assignmentId).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function reconcileJobsAfterSupervisorRestart(stateRoot: string): Promise<void> {
  for (const job of await listJobs(stateRoot)) {
    if (!["queued", "starting", "running"].includes(job.state)) continue;
    if (job.pid !== undefined && processAlive(job.pid)) continue;
    job.state = "interrupted";
    job.error = { code: "SUPERVISOR_PROCESS_LOST", message: "The supervisor restarted without an observable live provider process." };
    job.updated_at = new Date().toISOString();
    await writeJob(stateRoot, job);
  }
}

async function reconcileStoppedJobs(stateRoot: string): Promise<void> {
  for (const job of await listJobs(stateRoot)) {
    if (!["queued", "starting", "running"].includes(job.state)) continue;
    const session = job.control_session_id ? await readBrokeredSession(stateRoot, job.control_session_id) : undefined;
    if (session?.state !== "stopped" && session?.state !== "failed" && (job.pid === undefined || processAlive(job.pid))) continue;
    job.state = "interrupted";
    job.error = { code: "PROVIDER_INTERRUPTED", message: "The provider process stopped before the supervisor recorded a completed result." };
    job.updated_at = new Date().toISOString();
    await writeJob(stateRoot, job);
  }
}

async function workflowFor(input: LaunchRequest) {
  const effective = await loadEffectiveConfiguration({ projectRoot: input.projectRoot, requireProjectConfig: true });
  const repository = new StateWorkflowRepository({ projectRoot: input.projectRoot, stateDirectory: effective.config.state.directory, policySnapshot: { configuration_digest: effective.digest } });
  const adapter = {
    async requestStop() { return { confirmed: false }; },
    async createTransferPackage() { return { packageId: "supervisor-finalization", valid: false }; },
    async transferOwnership() { return { accepted: false }; },
  };
  const maxConcurrentOperations = effective.machine.concurrency?.maxOperations;
  return new WorkflowCommandService(repository, effective.config, adapter, maxConcurrentOperations === undefined ? {} : { maxConcurrentOperations });
}

function workflowContext(input: LaunchRequest): CommandContext {
  return { actor: { actorId: input.managerInstanceId, actorType: "manager" }, managerInstanceId: input.managerInstanceId, ownershipToken: input.ownershipToken };
}

async function submitSuccessfulMissionResult(input: LaunchRequest, finalMessage: string): Promise<string> {
  const service = await workflowFor(input); const context = workflowContext(input);
  const snapshot = await captureGitWorkspaceSnapshot(input.projectRoot).catch(() => undefined);
  await service.recordExecutionOutcome(input.assignmentId, input.executionId, "completed", context, snapshot);
  const resultId = `res-${randomUUID()}`;
  const summary = finalMessage.trim().slice(0, 8_000) || "Provider completed the Mission without a textual summary.";
  await service.submitResult(input.assignmentId, input.taskId, resultId, context, { executionId: input.executionId, deliveryStatus: "complete", summary });
  return resultId;
}

async function recordUnsuccessfulMissionRun(input: LaunchRequest, outcome: "failed" | "cancelled"): Promise<void> {
  const service = await workflowFor(input); const context = workflowContext(input);
  const snapshot = await captureGitWorkspaceSnapshot(input.projectRoot).catch(() => undefined);
  await service.recordExecutionOutcome(input.assignmentId, input.executionId, outcome, context, snapshot);
}

async function executeJob(stateRoot: string, input: LaunchRequest, job: SupervisorJobRecord, onSettled: () => void): Promise<void> {
  job.state = "starting"; job.updated_at = new Date().toISOString(); await writeJob(stateRoot, job);
  let renewalInFlight = false; let consecutiveRenewalFailures = 0; let leaseFailure: Error | undefined;
  const renewalTimer = setInterval(() => {
    if (renewalInFlight || leaseFailure) return;
    renewalInFlight = true;
    void renewOwnershipLease({ stateRoot, assignmentId: input.assignmentId, managerInstanceId: input.managerInstanceId, token: input.ownershipToken }).then(() => { consecutiveRenewalFailures = 0; }).catch(async (error) => {
      consecutiveRenewalFailures += 1;
      if (consecutiveRenewalFailures < 3) return;
      leaseFailure = Object.assign(new Error(`Mission ownership lease renewal failed three consecutive times: ${error instanceof Error ? error.message : String(error)}`), { code: "OWNERSHIP_RENEWAL_FAILED" });
      await interruptBrokeredSessions(stateRoot, input.assignmentId, "graceful", 5_000);
    }).finally(() => { renewalInFlight = false; });
  }, 60_000);
  renewalTimer.unref();
  try {
    const result = await runHeadlessProvider({
      stateRoot, projectRoot: input.projectRoot, provider: input.provider, phase: "execute", prompt: input.prompt,
      managerInstanceId: input.managerInstanceId, assignmentId: input.assignmentId, executionId: input.executionId, ownershipToken: input.ownershipToken,
      onSession: async (session: BrokeredSessionRecord) => {
        job.state = "running"; job.control_session_id = session.control_id; if (session.pid !== undefined) job.pid = session.pid; job.updated_at = new Date().toISOString(); await writeJob(stateRoot, job);
      },
      onEvent: async (event: HeadlessProviderEvent) => {
        job.event_count += 1;
        await appendJobEvent(stateRoot, job.job_id, { recorded_at: new Date().toISOString(), source_event: "mission.supervisor.event", job_id: job.job_id, event_index: job.event_count, kind: event.kind, source_type: event.sourceType, data: event.data });
      },
    });
    if (leaseFailure) throw leaseFailure;
    await appendJobEvent(stateRoot, job.job_id, { recorded_at: new Date().toISOString(), source_event: input.sourceEvent, job_id: job.job_id, kind: "final_response", final_message: result.finalMessage, event_count: result.events.length, stderr: result.stderr });
    const effective = await loadEffectiveConfiguration({ projectRoot: input.projectRoot, requireProjectConfig: true });
    let responseId: string | undefined;
    if (effective.config.providers[input.provider]?.captureRawResponses === true) {
      responseId = `raw-${randomUUID()}`;
      await persistRedactedRawResponse(stateRoot, { responseId, provider: input.provider, sourceEvent: input.sourceEvent, content: { job_id: job.job_id, kind: "final_response", final_message: result.finalMessage, event_count: result.events.length, stderr: result.stderr }, retentionDays: input.retentionDays, assignmentId: input.assignmentId });
    }
    job.result_id = await submitSuccessfulMissionResult(input, result.finalMessage);
    job.state = "completed"; if (result.providerSessionId) job.provider_session_id = result.providerSessionId; if (responseId) job.response_id = responseId; job.updated_at = new Date().toISOString(); await writeJob(stateRoot, job);
  } catch (error) {
    const session = job.control_session_id ? await readBrokeredSession(stateRoot, job.control_session_id) : undefined;
    job.state = session?.state === "stopped" ? "interrupted" : "failed";
    await recordUnsuccessfulMissionRun(input, job.state === "interrupted" ? "cancelled" : "failed").catch(() => undefined);
    job.error = { code: job.state === "interrupted" ? "PROVIDER_INTERRUPTED" : String((error as { code?: string }).code ?? "PROVIDER_EXECUTION_FAILED"), message: String(redactRawResponse(error instanceof Error ? error.message : String(error))) };
    await appendJobEvent(stateRoot, job.job_id, { recorded_at: new Date().toISOString(), source_event: input.sourceEvent, job_id: job.job_id, kind: "error", error: job.error }).catch(() => undefined);
    job.updated_at = new Date().toISOString(); await writeJob(stateRoot, job);
  } finally { clearInterval(renewalTimer); onSettled(); }
}

export async function serveSupervisor(stateRoot: string): Promise<Server> {
  const token = await ensureAuth(stateRoot); const endpoint = endpointFor(stateRoot);
  if (process.platform !== "win32") {
    try {
      await request(stateRoot, { action: "ping" }, 300);
      throw Object.assign(new Error("An Orbitkeep supervisor is already running for this Silo."), { code: "SUPERVISOR_ALREADY_RUNNING" });
    } catch (error) {
      if ((error as { code?: string }).code === "SUPERVISOR_ALREADY_RUNNING") throw error;
      await rm(endpoint, { force: true });
    }
  }
  await reconcileJobsAfterSupervisorRestart(stateRoot);
  let idleTimer: NodeJS.Timeout | undefined;
  const scheduleIdleShutdown = (timeoutMs: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void listJobs(stateRoot).then((jobs) => {
        if (!jobs.some((job) => ["queued", "starting", "running"].includes(job.state))) server.close();
      });
    }, timeoutMs);
    idleTimer.unref();
  };
  const server = createServer((socket) => {
    let buffer = ""; let handled = false; socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (handled || !buffer.includes("\n")) return;
      handled = true;
      void (async () => {
      let response: SupervisorResponse;
      try {
        const input = JSON.parse(buffer) as SupervisorRequest;
        if (!authorized(token, input.token ?? "")) throw Object.assign(new Error("Supervisor authentication failed."), { code: "SUPERVISOR_AUTH_FAILED" });
        if (input.action === "ping") response = { ok: true, value: { status: "running", pid: process.pid } };
        else if (input.action === "list") response = { ok: true, value: await listJobs(stateRoot, input.assignmentId) };
        else if (input.action === "status") response = { ok: true, value: await readJob(stateRoot, input.jobId) };
        else if (input.action === "shutdown") {
          await reconcileStoppedJobs(stateRoot);
          const active = (await listJobs(stateRoot)).filter((job) => ["queued", "starting", "running"].includes(job.state));
          if (active.length > 0 && !input.force) response = { ok: true, value: { status: "blocked", code: "SUPERVISOR_ACTIVE_MISSIONS", activeJobs: active.map((job) => ({ jobId: job.job_id, assignmentId: job.assignment_id, provider: job.provider, state: job.state })) } };
          else {
            const assignments = [...new Set(active.map((job) => job.assignment_id))];
            const controls = input.force ? (await Promise.all(assignments.map((assignmentId) => interruptBrokeredSessions(stateRoot, assignmentId, "force", input.timeoutMs)))).flat() : [];
            if (controls.some((control) => !control.confirmed)) response = { ok: true, value: { status: "blocked", code: "SUPERVISOR_SHUTDOWN_INCOMPLETE", controls } };
            else { response = { ok: true, value: { status: "stopping", code: "SUPERVISOR_STOPPING", interruptedJobs: active.length, controls } }; setTimeout(() => server.close(), 10); }
          }
        }
        else {
          const active = (await listJobs(stateRoot, input.assignmentId)).find((job) => ["queued", "starting", "running"].includes(job.state));
          if (active) throw Object.assign(new Error("This Mission already has an active background job."), { code: "MISSION_ALREADY_RUNNING" });
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
          const now = new Date().toISOString(); const job: SupervisorJobRecord = { schema_version: "1.0", job_id: `job-${randomUUID()}`, assignment_id: input.assignmentId, task_id: input.taskId, execution_id: input.executionId, provider: input.provider, phase: "execute", state: "queued", source_event: input.sourceEvent, manager_instance_id: input.managerInstanceId, created_at: now, updated_at: now, event_count: 0 };
          await writeJob(stateRoot, job); void executeJob(stateRoot, input, job, () => scheduleIdleShutdown(input.idleTimeoutMs)); response = { ok: true, value: job };
        }
      } catch (error) { response = { ok: false, error: { code: String((error as { code?: string }).code ?? "SUPERVISOR_ERROR"), message: error instanceof Error ? error.message : String(error) } }; }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  await writeJsonAtomic(stateRoot, recordRelativePath, { schema_version: "1.0", pid: process.pid, endpoint, started_at: new Date().toISOString(), token_digest: createHash("sha256").update(token).digest("hex") });
  server.once("close", () => { if (idleTimer) clearTimeout(idleTimer); if (process.platform !== "win32") void rm(endpoint, { force: true }); });
  return server;
}

export async function ensureSupervisor(stateRoot: string, projectRoot: string): Promise<void> {
  try { await request(stateRoot, { action: "ping" }, 500); return; } catch { /* start it */ }
  const entry = process.argv[1];
  if (!entry) throw Object.assign(new Error("Orbitkeep CLI entry point is unavailable."), { code: "SUPERVISOR_LAUNCH_FAILED" });
  const child = spawn(process.execPath, [entry, "__supervisor", "serve", "--project-root", projectRoot, "--state-root", stateRoot], { cwd: projectRoot, env: process.env, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { try { await request(stateRoot, { action: "ping" }, 300); return; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
  throw Object.assign(new Error("Orbitkeep supervisor could not be started."), { code: "SUPERVISOR_LAUNCH_FAILED" });
}

export async function launchSupervisorJob(stateRoot: string, input: LaunchRequest): Promise<SupervisorJobRecord> {
  await ensureSupervisor(stateRoot, input.projectRoot);
  return request(stateRoot, input) as Promise<SupervisorJobRecord>;
}
export async function supervisorJobs(stateRoot: string, assignmentId?: string): Promise<SupervisorJobRecord[]> {
  try { return await request(stateRoot, { action: "list", ...(assignmentId ? { assignmentId } : {}) }) as SupervisorJobRecord[]; }
  catch { return listJobs(stateRoot, assignmentId); }
}
export async function supervisorStatus(stateRoot: string, jobId: string): Promise<SupervisorJobRecord | undefined> {
  try { return await request(stateRoot, { action: "status", jobId }) as SupervisorJobRecord | undefined; }
  catch { return readJob(stateRoot, jobId); }
}
export interface SupervisorInspection { running: boolean; pid?: number; activeJobs: number; jobs: SupervisorJobRecord[] }
export async function inspectSupervisor(stateRoot: string): Promise<SupervisorInspection> {
  const auth = await readJson<{ token?: string }>(await assertContainedStatePath(stateRoot, authRelativePath));
  const jobs = await listJobs(stateRoot);
  if (!auth?.token) return { running: false, activeJobs: 0, jobs };
  try {
    const ping = await requestWithToken(stateRoot, auth.token, { action: "ping" }, 300) as { pid?: number };
    return { running: true, ...(ping.pid === undefined ? {} : { pid: ping.pid }), activeJobs: jobs.filter((job) => ["queued", "starting", "running"].includes(job.state)).length, jobs };
  } catch { return { running: false, activeJobs: 0, jobs }; }
}
export async function shutdownSupervisor(stateRoot: string, input: { force?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
  const auth = await readJson<{ token?: string }>(await assertContainedStatePath(stateRoot, authRelativePath));
  if (!auth?.token) return { status: "stopped", code: "SUPERVISOR_NOT_RUNNING" };
  try { return await requestWithToken(stateRoot, auth.token, { action: "shutdown", force: input.force ?? false, timeoutMs: input.timeoutMs ?? 5_000 }); }
  catch (error) {
    if (["ENOENT", "ECONNREFUSED", "EPIPE"].includes(String((error as NodeJS.ErrnoException).code))) return { status: "stopped", code: "SUPERVISOR_NOT_RUNNING" };
    throw error;
  }
}
export async function readSupervisorEvents(stateRoot: string, jobId: string, limit = DEFAULT_EVENT_LIMIT): Promise<unknown[]> {
  assertPortableId(jobId, "supervisor job ID");
  const effectiveLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : DEFAULT_EVENT_LIMIT;
  const logPath = await assertContainedStatePath(stateRoot, jobLogRelativePath(jobId));
  const log = await readFile(logPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (log !== undefined) {
    return log.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown).slice(-effectiveLimit);
  }
  // Compatibility fallback for jobs created before per-job logs existed. Read
  // sequentially so a large legacy raw-response directory cannot exhaust the
  // process file-descriptor limit.
  const directory = await assertContainedStatePath(stateRoot, "raw-responses");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const records: Array<{ recorded_at?: string; source_event?: string; [key: string]: unknown }> = [];
  for (const name of names) {
    // Canonical Orbitkeep raw responses are named raw-<id>.json. Older
    // project hooks may have left tens of thousands of unrelated metadata
    // files in the same directory; they cannot contain supervisor events.
    if (!name.startsWith("raw-") || !name.endsWith(".json")) continue;
    const record = await readJson<{ captured_at?: string; source_event?: string; content?: Record<string, unknown> }>(path.join(directory, name)).catch(() => undefined);
    if (record?.content?.job_id !== jobId) continue;
    records.push({ ...(record.captured_at ? { recorded_at: record.captured_at } : {}), ...(record.source_event ? { source_event: record.source_event } : {}), ...record.content });
  }
  return records.sort((a, b) => String(a.recorded_at ?? "").localeCompare(String(b.recorded_at ?? ""))).slice(-effectiveLimit);
}
