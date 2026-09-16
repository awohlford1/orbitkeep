import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildHeadlessProviderInvocation, normalizeHeadlessProviderEvent, selectHeadlessFinalMessage } from "../../src/control/headless.ts";

test("headless provider invocations use non-interactive JSON streams and safe planning sandboxes", () => {
  const root = path.resolve("fixture-project");
  const claude = buildHeadlessProviderInvocation("claude", "plan", root);
  assert.deepEqual(claude.args, ["-p", "--setting-sources=", "--settings", path.join(root, ".agent-workflow", "providers", "claude", "settings.json"), "--input-format", "text", "--output-format", "stream-json", "--verbose", "--permission-prompts", "none", "--permission-mode", "plan"]);
  assert.equal(claude.args.includes("--dangerously-skip-permissions"), false);

  const codex = buildHeadlessProviderInvocation("codex", "plan", root);
  assert.deepEqual(codex.args, ["exec", "--json", "--color", "never", "-C", root, "--sandbox", "read-only", "-"]);
  assert.equal(buildHeadlessProviderInvocation("codex", "execute", root).args.includes("workspace-write"), true);
});

test("provider-specific JSONL events normalize to a stable Orbitkeep event vocabulary", () => {
  const claude = normalizeHeadlessProviderEvent("claude", { type: "system", session_id: "claude-session" });
  assert.equal(claude.kind, "session_started");
  const codex = normalizeHeadlessProviderEvent("codex", { type: "item.completed", item: { type: "agent_message", text: "Done" } });
  assert.equal(codex.kind, "tool_completed");
  const failure = normalizeHeadlessProviderEvent("codex", { type: "error", message: "failed" });
  assert.equal(failure.kind, "error");
});

test("a final Claude hook outcome remains authoritative and cannot be hidden by earlier assistant text", () => {
  const events = [
    normalizeHeadlessProviderEvent("claude", { type: "assistant", message: { content: [{ type: "text", text: '{"approach":["Inspect"],"acceptanceCriteria":["Report"]}' }] } }),
    normalizeHeadlessProviderEvent("claude", { type: "result", result: "Stop hook feedback prevented shutdown." }),
  ];
  assert.equal(selectHeadlessFinalMessage(events), "Stop hook feedback prevented shutdown.");
  assert.equal(selectHeadlessFinalMessage([normalizeHeadlessProviderEvent("claude", { type: "result", result: "Fallback result" })]), "Fallback result");
});
