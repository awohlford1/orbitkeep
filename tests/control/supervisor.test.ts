import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readSupervisorEvents, serveSupervisor, supervisorJobs } from "../../src/control/supervisor.ts";
import { initializeStateRoot, writeJsonAtomic } from "../../src/storage/index.ts";

test("supervisor authenticates local IPC and reconciles an unobservable job after restart", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "orbitkeep-supervisor-"));
  const { stateRoot } = await initializeStateRoot(projectRoot);
  const at = new Date().toISOString();
  await writeJsonAtomic(stateRoot, path.join("control", "supervisor", "jobs", "job-stale.json"), {
    schema_version: "1.0", job_id: "job-stale", assignment_id: "asn-stale", provider: "codex", phase: "execute",
    state: "running", source_event: "test", manager_instance_id: "mgr-test", created_at: at, updated_at: at, event_count: 0,
  });
  const server = await serveSupervisor(stateRoot);
  try {
    const jobs = await supervisorJobs(stateRoot, "asn-stale");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.state, "interrupted");
    assert.equal(jobs[0]?.error?.code, "SUPERVISOR_PROCESS_LOST");
    const supervisorRecord = await readFile(path.join(stateRoot, "control", "supervisor", "supervisor.json"), "utf8");
    assert.doesNotMatch(supervisorRecord, /"token"\s*:/);
    assert.match(supervisorRecord, /"token_digest"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("mission logs prefer bounded per-job JSONL and ignore a large legacy raw-response directory", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "orbitkeep-supervisor-logs-"));
  const { stateRoot } = await initializeStateRoot(projectRoot);
  const rawDirectory = path.join(stateRoot, "raw-responses");
  const logDirectory = path.join(stateRoot, "control", "supervisor", "logs");
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(logDirectory, { recursive: true });
  await Promise.all(Array.from({ length: 2_000 }, (_, index) => writeFile(path.join(rawDirectory, `legacy-${index}.json`), JSON.stringify({ content: { job_id: "another-job" } }))));
  await writeFile(path.join(logDirectory, "job-current.jsonl"), [
    JSON.stringify({ recorded_at: "2026-01-01T00:00:00.000Z", job_id: "job-current", kind: "tool_started", source_type: "Read" }),
    JSON.stringify({ recorded_at: "2026-01-01T00:00:01.000Z", job_id: "job-current", kind: "message", data: { text: "working" } }),
    JSON.stringify({ recorded_at: "2026-01-01T00:00:02.000Z", job_id: "job-current", kind: "final_response", final_message: "done" }),
  ].join("\n") + "\n");
  const events = await readSupervisorEvents(stateRoot, "job-current", 2);
  assert.equal(events.length, 2);
  assert.equal((events[1] as { kind?: string }).kind, "final_response");
});

test("legacy mission-log fallback skips unrelated hook metadata files", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "orbitkeep-supervisor-legacy-logs-"));
  const { stateRoot } = await initializeStateRoot(projectRoot);
  const rawDirectory = path.join(stateRoot, "raw-responses");
  await mkdir(rawDirectory, { recursive: true });
  await Promise.all(Array.from({ length: 2_000 }, (_, index) => writeFile(path.join(rawDirectory, `toolu-${index}.metadata.json`), JSON.stringify({ content: { job_id: "job-legacy" } }))));
  await writeFile(path.join(rawDirectory, "raw-final.json"), JSON.stringify({ captured_at: "2026-01-01T00:00:00.000Z", source_event: "mission.execution.response", content: { job_id: "job-legacy", kind: "final_response", final_message: "legacy result" } }));
  const events = await readSupervisorEvents(stateRoot, "job-legacy", 100);
  assert.deepEqual(events, [{ recorded_at: "2026-01-01T00:00:00.000Z", source_event: "mission.execution.response", job_id: "job-legacy", kind: "final_response", final_message: "legacy result" }]);
});
