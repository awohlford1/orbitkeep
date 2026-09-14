import assert from "node:assert/strict";
import test from "node:test";
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
      health: { activation: "active", stateRoot: "/workspace/project/.agent-state", providerActivation: { claude: { status: "active" }, codex: { status: "active" } }, errors: [], warnings: [] },
    },
  });
  assert.ok(rendered);
  assert.equal(rendered.stream, "stdout");
  assert.match(rendered.text, /Orbitkeep setup complete/);
  assert.match(rendered.text, /Files: 2 created, 1 preserved/);
  assert.match(rendered.text, /claude: active/);
  assert.doesNotMatch(rendered.text, /"installation"/);
});

test("piped commands and explicit json retain stable structured output", () => {
  assert.equal(selectOutputMode({ argv: ["setup"], stdinIsTTY: false, stdoutIsTTY: false }), "json");
  assert.equal(selectOutputMode({ argv: ["setup", "--json"], stdinIsTTY: true, stdoutIsTTY: true }), "json");
  assert.equal(selectOutputMode({ argv: ["start", "--json", "{\"objective\":\"test\"}"], stdinIsTTY: true, stdoutIsTTY: true }), "json", "legacy inline --json input must also select JSON output");
  const rendered = formatCliOutput({ command: "setup", mode: "json", value: { status: "ready" } });
  assert.equal(rendered?.text, "{\n  \"status\": \"ready\"\n}\n");
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

test("Windows Node launched from WSL returns a specific actionable issue", () => {
  const issue = detectRuntimeEnvironmentIssue("win32", { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1_interop" });
  assert.equal(issue?.code, "WSL_WINDOWS_NODE_MISMATCH");
  assert.match(issue?.message ?? "", /Linux node, npm, and npx/);
  assert.equal(detectRuntimeEnvironmentIssue("linux", { WSL_DISTRO_NAME: "Ubuntu" }), undefined);
  assert.equal(detectRuntimeEnvironmentIssue("win32", {}), undefined);
});
