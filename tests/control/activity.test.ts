import assert from "node:assert/strict";
import test from "node:test";
import { currentMissionWork, meaningfulMissionActivity, summarizeMissionActivity } from "../../src/control/activity.ts";

function event(kind: string, data: Record<string, unknown>, recorded_at = "2026-09-16T19:36:44.441Z") {
  return { kind, data, recorded_at };
}

test("Claude activity exposes messages, tool intent, outcomes, and background tasks", () => {
  const values = [
    event("message", { type: "assistant", message: { content: [{ type: "text", text: "Inspecting the workspace layout now." }] } }),
    event("tool_started", { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "git status", description: "Check repository state" } }] } }),
    event("tool_completed", { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "clean", is_error: false }] } }),
    event("tool_started", { type: "system", subtype: "task_started", task_id: "task-1", task_type: "agent", description: "Review application boundaries" }),
    event("tool_completed", { type: "system", subtype: "task_notification", task_id: "task-1", status: "completed", summary: "Review complete" }),
    event("usage", { type: "system", subtype: "thinking_tokens" }),
  ];
  assert.deepEqual(meaningfulMissionActivity(values).map((item) => item.label), ["Agent", "Bash started", "Tool completed", "Process started", "Process completed"]);
  assert.equal(meaningfulMissionActivity(values)[1]?.detail, "Check repository state");
  assert.deepEqual(currentMissionWork(values), []);
  assert.equal(summarizeMissionActivity(event("result", { type: "result", result: "final" })), undefined);
});

test("active Claude and Codex work remains visible until its matching completion", () => {
  const claudeStart = event("tool_started", { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-2", name: "Agent", input: { description: "Inspect API package" } }] } });
  const codexStart = event("tool_started", { type: "item.started", item: { id: "item-1", type: "command_execution", command: "rg --files" } });
  assert.deepEqual(currentMissionWork([claudeStart, codexStart]).map((item) => [item.kind, item.name]), [["agent", "Agent"], ["tool", "command execution"]]);
  assert.match(summarizeMissionActivity(codexStart)?.label ?? "", /command execution started/);
  const completed = event("tool_completed", { type: "item.completed", item: { id: "item-1", type: "command_execution", command: "rg --files" } });
  assert.deepEqual(currentMissionWork([claudeStart, codexStart, completed]).map((item) => item.id), ["tool-2"]);
  const message = event("tool_completed", { type: "item.completed", item: { id: "item-2", type: "agent_message", text: "Architecture review complete." } });
  assert.equal(summarizeMissionActivity(message)?.detail, "Architecture review complete.");
});
