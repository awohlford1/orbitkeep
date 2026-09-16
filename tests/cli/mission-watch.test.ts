import assert from "node:assert/strict";
import test from "node:test";
import { MissionEventCursor, shouldAttachMissionWatcher } from "../../src/cli/mission-watch.ts";

const running = { code: "MISSION_RUNNING_IN_BACKGROUND", mission: { assignmentId: "asn-1" } };

test("interactive Mission launches attach by default while automation and detach remain non-blocking", () => {
  assert.equal(shouldAttachMissionWatcher({ mode: "human", stdinIsTTY: true, stdoutIsTTY: true, result: running }), true);
  assert.equal(shouldAttachMissionWatcher({ mode: "human", stdinIsTTY: true, stdoutIsTTY: true, detach: true, result: running }), false);
  assert.equal(shouldAttachMissionWatcher({ mode: "json", stdinIsTTY: true, stdoutIsTTY: true, result: running }), false);
  assert.equal(shouldAttachMissionWatcher({ mode: "human", stdinIsTTY: false, stdoutIsTTY: true, result: running }), false);
  assert.equal(shouldAttachMissionWatcher({ mode: "human", stdinIsTTY: true, stdoutIsTTY: true, result: { code: "APPROVAL_REQUIRED", mission: { assignmentId: "asn-1" } } }), false);
});

test("Mission event cursor replays a bounded tail and then emits each new event once", () => {
  const cursor = new MissionEventCursor(2);
  const first = [{ event_index: 1 }, { event_index: 2 }, { event_index: 3 }];
  assert.deepEqual(cursor.take(first), [{ event_index: 2 }, { event_index: 3 }]);
  assert.deepEqual(cursor.take([...first, { event_index: 4 }]), [{ event_index: 4 }]);
  assert.deepEqual(cursor.take([{ event_index: 2 }, { event_index: 3 }, { event_index: 4 }]), []);
  assert.deepEqual(cursor.take([{ event_index: 3 }, { event_index: 4 }, { event_index: 5 }]), [{ event_index: 5 }]);
});
