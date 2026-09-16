import type { OutputMode } from "./presentation.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function eventKey(value: unknown): string {
  const event = record(value);
  return typeof event.event_index === "number" ? `event:${event.event_index}` : `record:${JSON.stringify(event)}`;
}

export function shouldAttachMissionWatcher(input: { mode: OutputMode; stdinIsTTY?: boolean; stdoutIsTTY?: boolean; detach?: boolean; result: unknown }): boolean {
  const result = record(input.result); const mission = record(result.mission);
  return input.mode === "human" && input.stdinIsTTY === true && input.stdoutIsTTY === true && input.detach !== true
    && result.code === "MISSION_RUNNING_IN_BACKGROUND" && typeof mission.assignmentId === "string";
}

/** Bounded replay cursor for the supervisor's rolling event window. */
export class MissionEventCursor {
  readonly #replayLimit: number;
  #seen = new Set<string>();
  #initialized = false;

  constructor(replayLimit = 10) {
    if (!Number.isSafeInteger(replayLimit) || replayLimit < 0) throw new Error("Mission replay limit must be a nonnegative integer.");
    this.#replayLimit = replayLimit;
  }

  take(events: readonly unknown[]): unknown[] {
    const keys = new Set(events.map(eventKey));
    const fresh = this.#initialized ? events.filter((event) => !this.#seen.has(eventKey(event))) : events.slice(-this.#replayLimit);
    this.#seen = keys;
    this.#initialized = true;
    return fresh;
  }
}
