import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindBrokeredSession, completeBrokeredSession, createBrokeredSession, isBrokeredBootstrapOperation, isBrokeredManagementOperation, isBrokeredReadOnlyOperation, markBrokeredSessionRunning, readBrokeredSession, resolveBrokeredSession, resolveProviderExecutable } from "../../src/control/sessions.ts";
import { installConsumer } from "../../src/installer/index.ts";
import { initializeStateRoot } from "../../src/storage/index.ts";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(packageRoot, "dist", "cli", "index.js");

function runCli(root: string, args: string[], input: unknown, environment: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

test("brokered session capabilities are secret-bound and provider identities remain stable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-session-"));
  const { stateRoot } = await initializeStateRoot(root);
  const first = await createBrokeredSession(stateRoot, { provider: "claude" });
  const second = await createBrokeredSession(stateRoot, { provider: "claude" });
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => createBrokeredSession(stateRoot, { provider: "codex" })));
  assert.equal(first.record.manager_instance_id, second.record.manager_instance_id);
  assert.equal(new Set(concurrent.map((item) => item.record.manager_instance_id)).size, 1);
  assert.equal(first.record.schema_version, "1.0");
  assert.deepEqual(await resolveBrokeredSession(stateRoot, { ...first.environment }), first.record);
  assert.equal(await resolveBrokeredSession(stateRoot, { ...first.environment, ORBITKEEP_SESSION_SECRET: "wrong" }), undefined);
  assert.doesNotMatch(await readFile(path.join(stateRoot, "control", "sessions", `${first.record.control_id}.json`), "utf8"), new RegExp(first.environment.ORBITKEEP_SESSION_SECRET));
  const bound = await bindBrokeredSession(stateRoot, first.environment, { assignmentId: "asn-test", ownershipToken: "lease-test" });
  assert.equal(bound.assignment_id, "asn-test");
  assert.equal((await readBrokeredSession(stateRoot, first.record.control_id))?.ownership_token, "lease-test");
  const running = await markBrokeredSessionRunning(stateRoot, first.record.control_id, process.pid);
  assert.equal(running.state, "running");
  assert.equal(running.pid, process.pid);
  const completed = await completeBrokeredSession(stateRoot, first.record.control_id, "stopped", { exitCode: 0 });
  assert.equal(completed?.state, "stopped");
  assert.equal(completed?.exit_code, 0);
  assert.equal(completed?.ownership_token, undefined);
  assert.equal(await resolveBrokeredSession(stateRoot, first.environment), undefined);
});

test("Windows provider resolution prefers a native executable over an npm command shim", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbitkeep-provider-launch-"));
  await writeFile(path.join(directory, "codex.cmd"), "@exit /b 0\r\n");
  await writeFile(path.join(directory, "codex.exe"), "placeholder");
  const resolved = await resolveProviderExecutable("codex", { PATH: directory }, "win32");
  assert.equal(resolved.executable, path.join(directory, "codex.exe"));
  assert.equal(resolved.shell, false);
});

test("an explicit provider executable override is validated and wins deterministically", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbitkeep-provider-override-"));
  const command = path.join(directory, "codex.cmd");
  await writeFile(command, "@exit /b 0\r\n");
  assert.deepEqual(await resolveProviderExecutable("codex", { ORBITKEEP_CODEX_EXECUTABLE: command }, "win32"), { executable: command, shell: true });
  await assert.rejects(resolveProviderExecutable("codex", { ORBITKEEP_CODEX_EXECUTABLE: path.join(directory, "missing.exe") }, "win32"), (error: unknown) => (error as { code?: string }).code === "PROVIDER_CLI_NOT_FOUND");
});

test("bootstrap classifier permits read-only discovery and single Orbitkeep commands only", () => {
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Read", tool_input: { file_path: "README.md" } }), true);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Write", tool_input: { file_path: "README.md" } }), false);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep start --json '{}'" } }), true);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep start --json '{}'; rm -rf project" } }), false);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep start --json '{}' --project-root ../other" } }), false);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep start --json 'not-json'" } }), false);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep start --json '{}' --redact-output" } }), true);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Bash", tool_input: { command: "git status" } }), false);
  assert.equal(isBrokeredManagementOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep ownership-acquire --json '{}'" } }), true);
  assert.equal(isBrokeredManagementOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep approve-plan --json '{}'" } }), false);
  assert.equal(isBrokeredManagementOperation({ tool_name: "Read", tool_input: { file_path: "README.md" } }), false);
  assert.equal(isBrokeredReadOnlyOperation({ tool_name: "Read", tool_input: { file_path: "README.md" } }), true);
  assert.equal(isBrokeredReadOnlyOperation({ tool_name: "Bash", tool_input: { command: "npx --no-install orbitkeep start --json '{}'" } }), false);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Read", tool_input: { file_path: ".agent-state/locks/ownership/asn.json" } }), false);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Read", tool_input: { file_path: "../outside.txt" } }), false);
  assert.equal(isBrokeredBootstrapOperation({ tool_name: "Glob", tool_input: { pattern: ".agent-state/**" } }), false);
});

test("Claude planner sessions are discovery-only and cannot bootstrap workflow mutations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-claude-planner-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const { stateRoot } = await initializeStateRoot(root);
  const broker = await createBrokeredSession(stateRoot, { provider: "claude", kind: "planner" });
  const hook = (toolName: string, toolInput: Record<string, unknown>) => runCli(root, ["provider", "claude", "hook", "--json"], {
    hook_event_name: "PreToolUse", session_id: "claude-planner", tool_name: toolName, tool_input: toolInput,
  }, broker.environment);
  assert.deepEqual(JSON.parse((await hook("Read", { file_path: "README.md" })).stdout), {});
  assert.match((await hook("Bash", { command: "npx --no-install orbitkeep start --json '{}'" })).stdout, /WORKFLOW_PLANNING_READ_ONLY/);
  assert.match((await hook("Write", { file_path: "README.md", content: "denied" })).stdout, /WORKFLOW_PLANNING_READ_ONLY/);
});

test("Claude broker permits bootstrap reads, blocks writes before approval, and permits writes after approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-claude-broker-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const { stateRoot } = await initializeStateRoot(root);
  const broker = await createBrokeredSession(stateRoot, { provider: "claude" });
  const hook = (toolName: string, toolInput: Record<string, unknown>, env: NodeJS.ProcessEnv = broker.environment) => runCli(root, ["provider", "claude", "hook", "--json"], {
    hook_event_name: "PreToolUse", session_id: "claude-test", tool_name: toolName, tool_input: toolInput,
  }, env);

  const direct = await hook("Read", { file_path: "README.md" }, {});
  assert.match(direct.stdout, /WORKFLOW_BROKER_SESSION_REQUIRED/);
  const bootstrapRead = await hook("Read", { file_path: "README.md" });
  assert.deepEqual(JSON.parse(bootstrapRead.stdout), {});
  const bootstrapWrite = await hook("Write", { file_path: "README.md", content: "blocked" });
  assert.match(bootstrapWrite.stdout, /WORKFLOW_AUTHORIZATION_REQUIRED/);

  const nonCanonicalBootstrap = await hook("Bash", { command: "npx --no-install orbitkeep start --json <<'JSON'\n{}\nJSON" });
  assert.match(nonCanonicalBootstrap.stdout, /WORKFLOW_BOOTSTRAP_COMMAND_REQUIRED/);

  const started = await runCli(root, ["start", "--json"], { objective: "Broker UAT", approach: ["Create a file"], acceptanceCriteria: ["File exists"] }, broker.environment);
  assert.equal(started.code, 0, started.stderr);
  const startResult = JSON.parse(started.stdout) as { assignment: { assignmentId: string; ownershipLease: { token: string }; approvals: Array<{ approvalId: string }> } };
  const eventFiles = await readdir(path.join(stateRoot, "events"));
  const events = (await Promise.all(eventFiles.filter((name) => name.endsWith(".jsonl")).map(async (name) => (await readFile(path.join(stateRoot, "events", name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event_type?: string; actor?: { actor_id?: string }; data?: { command?: string } })))).flat();
  const received = events.find((event) => event.event_type === "manager.command_received" && event.data?.command === "start");
  assert.equal(received?.actor?.actor_id, broker.record.manager_instance_id);
  const stillBlocked = await hook("Write", { file_path: "README.md", content: "blocked" });
  assert.match(stillBlocked.stdout, /WORKFLOW_EXECUTION_NOT_AUTHORIZED/);

  const selfApproval = await runCli(root, ["approve-plan", "--json"], { approvalId: startResult.assignment.approvals[0]!.approvalId, actorType: "executive", actorId: "executive:test" }, broker.environment);
  assert.equal(selfApproval.code, 1);
  assert.equal((JSON.parse(selfApproval.stdout) as { code: string }).code, "EXECUTIVE_CHANNEL_REQUIRED");
  const approved = await runCli(root, ["approve-plan", "--json"], { assignmentId: startResult.assignment.assignmentId, ownershipToken: startResult.assignment.ownershipLease.token, approvalId: startResult.assignment.approvals[0]!.approvalId, actorType: "executive", actorId: "executive:test", managerInstanceId: broker.record.manager_instance_id });
  assert.equal(approved.code, 0, approved.stderr);
  const authorizedWrite = await hook("Write", { file_path: "README.md", content: "allowed" });
  assert.deepEqual(JSON.parse(authorizedWrite.stdout), {});
});

test("retired interactive session launch never starts a provider process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-retired-session-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const result = await runCli(root, ["session", "launch", "--provider", "claude", "--json"], {});
  assert.equal(result.code, 1);
  const failure = JSON.parse(result.stdout) as { code: string; message: string };
  assert.equal(failure.code, "COMMAND_RETIRED");
  assert.match(failure.message, /mission start/);
});
