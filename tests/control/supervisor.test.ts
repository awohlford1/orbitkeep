import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { serveSupervisor, supervisorJobs } from "../../src/control/supervisor.ts";
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
