import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installConsumer } from "../../src/installer/index.ts";
import { StateWorkflowRepository } from "../../src/commands/index.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(packageRoot, "dist", "cli", "index.js");

async function fakeCodex(directory: string): Promise<{ bin: string; executable: string }> {
  const bin = path.join(directory, "bin");
  await mkdir(bin, { recursive: true });
  const script = path.join(bin, "fake-provider.mjs");
  await writeFile(script, [
    'let prompt = "";',
    'for await (const chunk of process.stdin) prompt += chunk;',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-headless-test" }));',
    'const text = prompt.includes("headless planning worker")',
    '  ? JSON.stringify({ approach: ["Inspect safely"], acceptanceCriteria: ["Summary is produced"] })',
    '  : "Execution completed through the Orbitkeep parent process.";',
    'if (!prompt.includes("headless planning worker") && prompt.includes("Keep running until stopped")) {',
    '  console.log(JSON.stringify({ type: "item.started", item: { id: "live-work", type: "command_execution", command: "inspect repository" } }));',
    '  await new Promise((resolve) => setTimeout(resolve, 10_000));',
    '  console.log(JSON.stringify({ type: "item.completed", item: { id: "live-work", type: "command_execution", command: "inspect repository" } }));',
    '}',
    'console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));',
    'console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));',
  ].join("\n"));
  if (process.platform === "win32") {
    const executable = path.join(bin, "codex.cmd");
    await writeFile(executable, '@echo off\r\nnode "%~dp0fake-provider.mjs" %*\r\n');
    return { bin, executable };
  } else {
    const executable = path.join(bin, "codex");
    await writeFile(executable, '#!/bin/sh\nnode "$(dirname "$0")/fake-provider.mjs" "$@"\n');
    await chmod(executable, 0o755);
    return { bin, executable };
  }
}

function run(root: string, environment: NodeJS.ProcessEnv, args: string[], input: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, "--json", JSON.stringify(input)], {
      cwd: root, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForLatestJob(root: string, environment: NodeJS.ProcessEnv, provider: "codex" | "claude", missionId: string): Promise<{ state: string; response_id?: string; job_id: string; event_count: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const statusResult = await run(root, environment, ["mission", "status"], { provider, missionId });
    assert.equal(statusResult.code, 0, `${statusResult.stderr}\n${statusResult.stdout}`);
    const status = JSON.parse(statusResult.stdout) as { jobs: Array<{ state: string; response_id?: string; job_id: string; event_count: number }> };
    const job = status.jobs[0];
    if (job && ["completed", "failed", "interrupted"].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the detached supervisor job.");
}

async function waitForLiveProgress(root: string, environment: NodeJS.ProcessEnv, provider: "codex" | "claude", missionId: string): Promise<{ state: string; event_count: number; last_activity_at?: string; pid?: number }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const statusResult = await run(root, environment, ["mission", "status"], { provider, missionId });
    assert.equal(statusResult.code, 0, `${statusResult.stderr}\n${statusResult.stdout}`);
    const status = JSON.parse(statusResult.stdout) as { jobs: Array<{ state: string; event_count: number; last_activity_at?: string; pid?: number }> };
    const job = status.jobs[0];
    if (job && job.state === "running" && job.event_count >= 2 && job.last_activity_at) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for live Mission progress.");
}

test("mission start owns planning, approval, and headless execution outside the provider interface", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-headless-mission-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const fake = await fakeCodex(root);
  const environment = { PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`, ORBITKEEP_CODEX_EXECUTABLE: fake.executable };
  const result = await run(root, environment, ["mission", "start", "--approve"], { objective: "Produce a read-only repository summary", provider: "codex" });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const response = JSON.parse(result.stdout) as {
    status: string;
    code: string;
    mission: { assignmentId: string; lifecycle: string };
    plan: { approach: string[]; acceptanceCriteria: string[] };
    result: string;
  };
  assert.equal(response.status, "running");
  assert.equal(response.code, "MISSION_RUNNING_IN_BACKGROUND");
  assert.equal(response.mission.lifecycle, "running");
  assert.deepEqual(response.plan.approach, ["Inspect safely"]);
  assert.deepEqual(response.plan.acceptanceCriteria, ["Summary is produced"]);
  assert.doesNotMatch(result.stdout, /ownershipToken|ORBITKEEP_SESSION_SECRET/);
  const completed = await waitForLatestJob(root, environment, "codex", response.mission.assignmentId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.response_id, undefined, "raw provider capture is opt-in");
  assert.ok(completed.event_count > 0);
  const aggregate = await new StateWorkflowRepository({ projectRoot: root }).get(response.mission.assignmentId);
  assert.equal(aggregate?.executions.length, 1);
  assert.equal(aggregate?.executions[0]?.state, "completed");
  assert.equal(aggregate?.tasks[0]?.state, "result_submitted");
  assert.equal(aggregate?.results.length, 1);
  assert.match(aggregate?.results[0]?.summary ?? "", /Execution completed through the Orbitkeep parent process/);
  const jobRecord = await readFile(path.join(root, ".agent-state", "control", "supervisor", "jobs", `${completed.job_id}.json`), "utf8");
  assert.doesNotMatch(jobRecord, /Execution completed through the Orbitkeep parent process|ownershipToken|ORBITKEEP_SESSION_SECRET/);
  const activityLog = await readFile(path.join(root, ".agent-state", "control", "supervisor", "logs", `${completed.job_id}.jsonl`), "utf8");
  assert.match(activityLog, /Execution completed through the Orbitkeep parent process/);
  assert.doesNotMatch(activityLog, /ownershipToken|ORBITKEEP_SESSION_SECRET/);
  const assignmentRecord = await readFile(path.join(root, ".agent-state", "assignments", response.mission.assignmentId, "assignment", `${response.mission.assignmentId}.json`), "utf8");
  assert.match(assignmentRecord, /"execution_authority": "authorized"/);

  const statusResult = await run(root, environment, ["mission", "status"], { provider: "codex" });
  assert.equal(statusResult.code, 0, `${statusResult.stderr}\n${statusResult.stdout}`);
  const status = JSON.parse(statusResult.stdout) as { missions: Array<{ objective: string; lifecycle: string }> };
  assert.deepEqual(status.missions.map((mission) => mission.objective), ["Produce a read-only repository summary"]);
  assert.equal(status.missions[0]?.lifecycle, "running");
  assert.doesNotMatch(statusResult.stdout, /ownershipToken|ownershipLease|ORBITKEEP_SESSION_SECRET/);

  const logsResult = await run(root, environment, ["mission", "logs"], { provider: "codex", missionId: response.mission.assignmentId });
  assert.equal(logsResult.code, 0, `${logsResult.stderr}\n${logsResult.stdout}`);
  const logs = JSON.parse(logsResult.stdout) as { code: string; events: unknown[]; result: string; job: { state: string } };
  assert.equal(logs.code, "MISSION_LOGS_AVAILABLE");
  assert.equal(logs.job.state, "completed");
  assert.ok(logs.events.length > 0);
  assert.match(logs.result, /Execution completed through the Orbitkeep parent process/);

  const askResult = await run(root, environment, ["mission", "ask"], { provider: "codex", question: "What is the current objective?" });
  assert.equal(askResult.code, 0, `${askResult.stderr}\n${askResult.stdout}`);
  const answer = JSON.parse(askResult.stdout) as { code: string; answer: string };
  assert.equal(answer.code, "MISSION_QUESTION_ANSWERED");
  assert.match(answer.answer, /Execution completed through the Orbitkeep parent process/);

  const pauseResult = await run(root, environment, ["mission", "pause"], { provider: "codex", mode: "graceful" });
  assert.equal(pauseResult.code, 0, `${pauseResult.stderr}\n${pauseResult.stdout}`);
  const paused = JSON.parse(pauseResult.stdout) as { code: string; mission: { lifecycle: string } };
  assert.equal(paused.code, "PAUSED");
  assert.equal(paused.mission.lifecycle, "paused");

  const resumeResult = await run(root, environment, ["mission", "resume", "--approve"], { provider: "codex" });
  assert.equal(resumeResult.code, 0, `${resumeResult.stderr}\n${resumeResult.stdout}`);
  const resumed = JSON.parse(resumeResult.stdout) as { status: string; mission: { lifecycle: string } };
  assert.equal(resumed.status, "running");
  assert.equal(resumed.mission.lifecycle, "running");
  assert.equal((await waitForLatestJob(root, environment, "codex", response.mission.assignmentId)).state, "completed");

  const steerResult = await run(root, environment, ["mission", "steer", "--approve"], { provider: "codex", instruction: "Concentrate the summary on source boundaries", paths: ["src/**"] });
  assert.equal(steerResult.code, 0, `${steerResult.stderr}\n${steerResult.stdout}`);
  const steered = JSON.parse(steerResult.stdout) as { status: string; mission: { lifecycle: string; plan: { revision: number } } };
  assert.equal(steered.status, "running");
  assert.equal(steered.mission.lifecycle, "running");
  assert.equal(steered.mission.plan.revision, 2);
  assert.equal((await waitForLatestJob(root, environment, "codex", response.mission.assignmentId)).state, "completed");
  assert.doesNotMatch(steerResult.stdout, /ownershipToken|ownershipLease|ORBITKEEP_SESSION_SECRET/);

  const handoverResult = await run(root, environment, ["mission", "handover"], { provider: "codex", toProvider: "claude", mode: "graceful" });
  assert.equal(handoverResult.code, 0, `${handoverResult.stderr}\n${handoverResult.stdout}`);
  const handed = JSON.parse(handoverResult.stdout) as { code: string; fromProvider: string; toProvider: string; mission: { lifecycle: string } };
  assert.equal(handed.code, "HANDOVER_ACCEPTED");
  assert.equal(handed.fromProvider, "codex");
  assert.equal(handed.toProvider, "claude");
  assert.equal(handed.mission.lifecycle, "handover_ready");

  const targetStatusResult = await run(root, environment, ["mission", "status"], { provider: "claude" });
  assert.equal(targetStatusResult.code, 0, `${targetStatusResult.stderr}\n${targetStatusResult.stdout}`);
  const targetStatus = JSON.parse(targetStatusResult.stdout) as { missions: Array<{ objective: string }> };
  assert.deepEqual(targetStatus.missions.map((mission) => mission.objective), ["Produce a read-only repository summary"]);

  const helpResult = await run(root, environment, ["help"], {});
  assert.equal(helpResult.code, 0, `${helpResult.stderr}\n${helpResult.stdout}`);
  const help = JSON.parse(helpResult.stdout) as { commands: string[] };
  assert.ok(help.commands.some((command) => command.startsWith("mission start|list|status|logs|watch|accept|ask|steer|pause|resume|stop|cancel|handover")));
  assert.ok(help.commands.includes("supervisor status|stop [--force]"));
  assert.ok(help.commands.includes("provider doctor --provider claude|codex"));
  assert.equal(help.commands.some((command) => command.includes("session launch")), false);
  assert.equal(help.commands.includes("approve-plan"), false);
  assert.equal(help.commands.some((command) => command.startsWith("control launch")), false);

  const shutdown = await run(root, environment, ["__supervisor", "shutdown", "--state-root", path.join(root, ".agent-state")], {});
  assert.equal(shutdown.code, 0, `${shutdown.stderr}\n${shutdown.stdout}`);
});

test("an Executive explicitly accepts a submitted Mission Report and closes the Mission", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-mission-accept-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const fake = await fakeCodex(root);
  const environment = { PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`, ORBITKEEP_CODEX_EXECUTABLE: fake.executable };
  const startedResult = await run(root, environment, ["mission", "start", "--approve"], { objective: "Produce a Mission Report for acceptance", provider: "codex" });
  assert.equal(startedResult.code, 0, `${startedResult.stderr}\n${startedResult.stdout}`);
  const started = JSON.parse(startedResult.stdout) as { mission: { assignmentId: string } };
  assert.equal((await waitForLatestJob(root, environment, "codex", started.mission.assignmentId)).state, "completed");

  const acceptResult = await run(root, environment, ["mission", "accept"], { provider: "codex", missionId: started.mission.assignmentId });
  assert.equal(acceptResult.code, 0, `${acceptResult.stderr}\n${acceptResult.stdout}`);
  const accepted = JSON.parse(acceptResult.stdout) as { code: string; mission: { lifecycle: string }; acceptedResults: string[] };
  assert.equal(accepted.code, "ASSIGNMENT_CLOSED");
  assert.equal(accepted.mission.lifecycle, "closed");
  assert.equal(accepted.acceptedResults.length, 1);
  const aggregate = await new StateWorkflowRepository({ projectRoot: root }).get(started.mission.assignmentId);
  assert.ok(aggregate?.tasks.every((task) => task.state === "closed"));
  const shutdown = await run(root, environment, ["__supervisor", "shutdown", "--state-root", path.join(root, ".agent-state")], {});
  assert.equal(shutdown.code, 0, `${shutdown.stderr}\n${shutdown.stdout}`);
});

test("public supervisor controls discover active work and require an explicit forced stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-supervisor-controls-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const fake = await fakeCodex(root);
  const environment = { PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`, ORBITKEEP_CODEX_EXECUTABLE: fake.executable };
  const startedResult = await run(root, environment, ["mission", "start", "--approve"], { objective: "Keep running until stopped", provider: "codex" });
  assert.equal(startedResult.code, 0, `${startedResult.stderr}\n${startedResult.stdout}`);
  const started = JSON.parse(startedResult.stdout) as { mission: { assignmentId: string } };

  const live = await waitForLiveProgress(root, environment, "codex", started.mission.assignmentId);
  assert.ok(live.event_count >= 2, "event count is checkpointed while the provider is still running");
  assert.ok(live.last_activity_at);
  assert.ok(live.pid);

  const statusResult = await run(root, environment, ["mission", "status"], { provider: "codex" });
  assert.equal(statusResult.code, 0, `${statusResult.stderr}\n${statusResult.stdout}`);
  const status = JSON.parse(statusResult.stdout) as { mission: { objective: string }; nextStep: string };
  assert.equal(status.mission.objective, "Keep running until stopped");
  assert.match(status.nextStep, /still running/);

  const supervisorResult = await run(root, environment, ["supervisor", "status"], {});
  assert.equal(supervisorResult.code, 0, `${supervisorResult.stderr}\n${supervisorResult.stdout}`);
  const supervisor = JSON.parse(supervisorResult.stdout) as { supervisor: { activeMissions: Array<{ objective: string; process: { pid?: number }; currentWork: Array<{ name: string }> }> } };
  assert.equal(supervisor.supervisor.activeMissions[0]?.objective, "Keep running until stopped");
  assert.ok(supervisor.supervisor.activeMissions[0]?.process.pid);
  assert.deepEqual(supervisor.supervisor.activeMissions[0]?.currentWork.map((item) => item.name), ["command execution"]);

  const listedResult = await run(root, environment, ["mission", "list"], {});
  assert.equal(listedResult.code, 0, `${listedResult.stderr}\n${listedResult.stdout}`);
  const listed = JSON.parse(listedResult.stdout) as { missions: Array<{ missionId: string }>; supervisor: { running: boolean; activeJobs: number } };
  assert.equal(listed.supervisor.running, true);
  assert.equal(listed.supervisor.activeJobs, 1);
  assert.ok(listed.missions.some((mission) => mission.missionId === started.mission.assignmentId));

  const refusedResult = await run(root, environment, ["supervisor", "stop"], {});
  assert.equal(refusedResult.code, 0, `${refusedResult.stderr}\n${refusedResult.stdout}`);
  const refused = JSON.parse(refusedResult.stdout) as { status: string; code: string; activeJobs: unknown[] };
  assert.equal(refused.status, "blocked");
  assert.equal(refused.code, "SUPERVISOR_ACTIVE_MISSIONS");
  assert.equal(refused.activeJobs.length, 1);

  const stoppedResult = await run(root, environment, ["mission", "stop", "--force"], { provider: "codex", missionId: started.mission.assignmentId });
  assert.equal(stoppedResult.code, 0, `${stoppedResult.stderr}\n${stoppedResult.stdout}`);
  const stopped = JSON.parse(stoppedResult.stdout) as { code: string; mission: { lifecycle: string } };
  assert.equal(stopped.code, "ASSIGNMENT_CLOSED");
  assert.equal(stopped.mission.lifecycle, "closed");

  const shutdownResult = await run(root, environment, ["supervisor", "stop"], {});
  assert.equal(shutdownResult.code, 0, `${shutdownResult.stderr}\n${shutdownResult.stdout}`);
  const shutdown = JSON.parse(shutdownResult.stdout) as { status: string; code: string };
  assert.equal(shutdown.status, "stopping");
  assert.equal(shutdown.code, "SUPERVISOR_STOPPING");
});
