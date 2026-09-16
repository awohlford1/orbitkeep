import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { providerCliRuntime } from "../../src/cli/diagnostics.ts";
import { formatCliOutput, selectOutputMode } from "../../src/cli/presentation.ts";
import { detectRuntimeEnvironmentIssue } from "../../src/cli/runtime-environment.ts";

test("interactive terminals default to concise human output", () => {
  assert.equal(selectOutputMode({ argv: ["setup"], stdinIsTTY: true, stdoutIsTTY: true }), "human");
  const rendered = formatCliOutput({
    command: "setup",
    mode: "human",
    value: {
      status: "ready",
      installation: { projectRoot: "/workspace/project", created: ["a", "b"], preserved: ["c"], legacyDetected: false },
      health: { activation: "active", stateRoot: "/workspace/project/.agent-state", providerActivation: { claude: { status: "active" }, codex: { status: "active" } }, providerRuntime: { claude: { available: false }, codex: { available: true } }, errors: [], warnings: [] },
    },
  });
  assert.ok(rendered);
  assert.equal(rendered.stream, "stdout");
  assert.match(rendered.text, /Orbitkeep setup complete/);
  assert.match(rendered.text, /Files: 2 created, 1 preserved/);
  assert.match(rendered.text, /claude: active/);
  assert.match(rendered.text, /claude: active \(CLI not found\)/);
  assert.doesNotMatch(rendered.text, /"installation"/);
});

test("provider runtime detection distinguishes an installed integration from an executable on PATH", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbitkeep-provider-path-"));
  const filename = path.join(directory, process.platform === "win32" ? "claude.CMD" : "claude");
  await writeFile(filename, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const environment = { PATH: directory, ...(process.platform === "win32" ? { PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}) };
  assert.equal((await providerCliRuntime("claude", environment, process.platform)).available, true);
  assert.equal((await providerCliRuntime("codex", environment, process.platform)).available, false);
});

test("piped commands and explicit json retain stable structured output", () => {
  assert.equal(selectOutputMode({ argv: ["setup"], stdinIsTTY: false, stdoutIsTTY: false }), "json");
  assert.equal(selectOutputMode({ argv: ["setup", "--json"], stdinIsTTY: true, stdoutIsTTY: true }), "json");
  assert.equal(selectOutputMode({ argv: ["start", "--json", "{\"objective\":\"test\"}"], stdinIsTTY: true, stdoutIsTTY: true }), "json", "legacy inline --json input must also select JSON output");
  const rendered = formatCliOutput({ command: "setup", mode: "json", value: { status: "ready" } });
  assert.equal(rendered?.text, "{\n  \"status\": \"ready\"\n}\n");
});

test("version has a conventional concise terminal projection and structured JSON output", () => {
  const human = formatCliOutput({ command: "version", mode: "human", value: { version: "0.5.0" } });
  assert.equal(human?.text, "0.5.0\n");
  const json = formatCliOutput({ command: "version", mode: "json", value: { version: "0.5.0" } });
  assert.equal(json?.text, "{\n  \"version\": \"0.5.0\"\n}\n");
});

test("verbose and quiet modes are explicit and mutually exclusive", () => {
  assert.equal(selectOutputMode({ argv: ["doctor", "--verbose"], stdinIsTTY: false, stdoutIsTTY: false }), "verbose");
  assert.equal(selectOutputMode({ argv: ["setup", "--quiet"], stdinIsTTY: true, stdoutIsTTY: true }), "quiet");
  assert.throws(() => selectOutputMode({ argv: ["setup", "--json", "--verbose"], stdinIsTTY: true, stdoutIsTTY: true }), /Choose only one output mode/);
  assert.equal(formatCliOutput({ command: "setup", mode: "quiet", value: { status: "ready" } }), undefined);
  const failure = formatCliOutput({ command: "setup", mode: "quiet", failed: true, value: { code: "CLI_ERROR", message: "broken" } });
  assert.equal(failure?.stream, "stderr");
  assert.match(failure?.text ?? "", /broken/);
});

test("Silo status and derivation have concise human projections", () => {
  const status = formatCliOutput({ command: "silo", mode: "human", value: { identity: { valid: true, siloId: "silo-a", siloInstanceId: "sinst-b" }, administrativeState: "unregistered", connectivityState: "offline", healthState: "healthy", displayState: "unregistered" } });
  assert.match(status?.text ?? "", /Silo identity is valid/);
  assert.match(status?.text ?? "", /Administrative: unregistered/);
  const derive = formatCliOutput({ command: "silo", mode: "human", value: { previousSiloId: "silo-old", descriptor: { silo_id: "silo-new" }, instance: { silo_instance_id: "sinst-new" }, transactionId: "itx-1" } });
  assert.match(derive?.text ?? "", /New Silo identity derived/);
  assert.match(derive?.text ?? "", /Derived from: silo-old/);
  assert.match(derive?.text ?? "", /Commit `.agent-workflow\/silo.json`/);
});

test("detached Missions explain background execution and reconnectable logs", () => {
  const launched = formatCliOutput({ command: "mission", mode: "human", value: { status: "running", code: "MISSION_RUNNING_IN_BACKGROUND", mission: { objective: "Inspect safely" }, provider: { name: "codex" }, job: { state: "queued" } } });
  assert.match(launched?.text ?? "", /Mission launched/);
  assert.match(launched?.text ?? "", /close this terminal/);
  assert.match(launched?.text ?? "", /mission logs/);
  assert.match(launched?.text ?? "", /mission stop --provider codex/);
  assert.match(launched?.text ?? "", /supervisor stop/);
  const logs = formatCliOutput({ command: "mission", mode: "human", value: { code: "MISSION_LOGS_AVAILABLE", mission: { objective: "Inspect safely" }, job: { state: "completed" }, events: [{ kind: "tool_started", source_type: "Read" }, { kind: "result", data: { result: "Finished safely" } }], result: "Finished safely" } });
  assert.match(logs?.text ?? "", /Mission activity loaded/);
  assert.match(logs?.text ?? "", /Recent activity/);
  assert.match(logs?.text ?? "", /tool started: Read/i);
  assert.match(logs?.text ?? "", /Finished safely/);
});

test("provider doctor has a concise readiness projection", () => {
  const rendered = formatCliOutput({ command: "provider", mode: "human", value: { status: "ready", provider: "claude", activation: { status: "active" }, runtime: { available: true }, authentication: { state: "authenticated", reason: "Claude reports an authenticated local session." }, permissionControl: { state: "enforced" }, headlessExecution: { supported: true } } });
  assert.match(rendered?.text ?? "", /claude is ready for Orbitkeep/);
  assert.match(rendered?.text ?? "", /Authentication: authenticated/);
  assert.doesNotMatch(rendered?.text ?? "", /\{/);
});

test("Windows Node launched from WSL returns a specific actionable issue", () => {
  const issue = detectRuntimeEnvironmentIssue("win32", { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop" });
  assert.equal(issue?.code, "WSL_WINDOWS_NODE_MISMATCH");
  assert.match(issue?.message ?? "", /Linux node, npm, and npx/);
  assert.equal(detectRuntimeEnvironmentIssue("linux", { WSL_DISTRO_NAME: "Ubuntu" }), undefined);
  assert.equal(detectRuntimeEnvironmentIssue("win32", {}), undefined);
});
