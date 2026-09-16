export interface MissionActivitySummary {
  at?: string;
  category: "message" | "tool" | "process" | "session" | "error";
  label: string;
  detail?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function blocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function compact(value: unknown, limit = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : undefined;
}

/** Converts a normalized provider event into a concise operator-facing activity. */
export function summarizeMissionActivity(value: unknown): MissionActivitySummary | undefined {
  const event = record(value); const data = record(event.data); const message = record(data.message); const item = record(data.item);
  const at = typeof event.recorded_at === "string" ? event.recorded_at : undefined;
  const withAt = <T extends Omit<MissionActivitySummary, "at">>(summary: T): MissionActivitySummary => ({ ...summary, ...(at ? { at } : {}) });
  const summary = (category: MissionActivitySummary["category"], label: string, detail?: string) => withAt({ category, label, ...(detail ? { detail } : {}) });
  if (event.kind === "error") return summary("error", "Error", compact(record(event.error).message ?? data.message));
  if (event.kind === "final_response" || event.kind === "result") return undefined;

  const content = blocks(message.content ?? data.content);
  const toolUse = content.find((item) => item.type === "tool_use");
  if (toolUse) {
    const input = record(toolUse.input); const name = compact(toolUse.name, 60) ?? "tool";
    return summary("tool", `${name} started`, compact(input.description ?? input.command ?? input.path ?? input.file_path));
  }
  const toolResult = content.find((item) => item.type === "tool_result");
  if (toolResult) return summary("tool", toolResult.is_error === true ? "Tool failed" : "Tool completed", compact(toolResult.content));
  const text = content.map((item) => item.type === "text" ? compact(item.text, 500) : undefined).filter(Boolean).join(" ");
  if (text) return withAt({ category: "message", label: "Agent", detail: text });

  if (data.type === "system") {
    const subtype = String(data.subtype ?? "");
    if (subtype === "task_started") return summary("process", "Process started", compact(data.description ?? data.task_type));
    if (subtype === "task_notification") return summary("process", `Process ${String(data.status ?? "updated")}`, compact(data.summary));
    if (["init", "session_started"].includes(subtype)) return withAt({ category: "session", label: "Provider session started" });
    return undefined;
  }
  if (Object.keys(item).length > 0) {
    const itemType = String(item.type ?? "work");
    const name = compact(item.name ?? itemType.replaceAll("_", " "), 60) ?? "work";
    const detail = compact(item.text ?? item.command ?? item.summary ?? item.output);
    if (itemType === "agent_message" && detail) return summary("message", "Agent", detail);
    if (event.kind === "tool_started") return summary(itemType.includes("agent") ? "process" : "tool", `${name} started`, detail);
    if (event.kind === "tool_completed") return summary(itemType.includes("agent") ? "process" : "tool", `${name} completed`, detail);
  }
  const direct = compact(data.result ?? data.text);
  return direct ? withAt({ category: "message", label: "Agent", detail: direct }) : undefined;
}

export function meaningfulMissionActivity(events: readonly unknown[], limit = 10): MissionActivitySummary[] {
  return events.map(summarizeMissionActivity).filter((item): item is MissionActivitySummary => item !== undefined).slice(-limit);
}

/** Tracks provider work that has started but has no matching completion event. */
export function currentMissionWork(events: readonly unknown[]): Array<{ id: string; kind: string; name: string; detail?: string; startedAt?: string }> {
  const active = new Map<string, { id: string; kind: string; name: string; detail?: string; startedAt?: string }>();
  for (const value of events) {
    const event = record(value); const data = record(event.data); const message = record(data.message); const content = blocks(message.content ?? data.content); const item = record(data.item);
    for (const item of content) {
      if (item.type === "tool_use" && typeof item.id === "string") {
        const input = record(item.input); const detail = compact(input.description ?? input.command);
        active.set(item.id, { id: item.id, kind: String(item.name ?? "tool").toLowerCase().includes("agent") ? "agent" : "tool", name: String(item.name ?? "tool"), ...(detail ? { detail } : {}), ...(typeof event.recorded_at === "string" ? { startedAt: event.recorded_at } : {}) });
      }
      if (item.type === "tool_result" && typeof item.tool_use_id === "string") active.delete(item.tool_use_id);
    }
    if (data.type === "system" && data.subtype === "task_started" && typeof data.task_id === "string") {
      const detail = compact(data.description); active.set(data.task_id, { id: data.task_id, kind: String(data.task_type ?? "process").includes("agent") ? "agent" : "process", name: String(data.task_type ?? "process"), ...(detail ? { detail } : {}), ...(typeof event.recorded_at === "string" ? { startedAt: event.recorded_at } : {}) });
    }
    if (data.type === "system" && data.subtype === "task_notification" && typeof data.task_id === "string" && ["completed", "failed", "stopped"].includes(String(data.status))) active.delete(data.task_id);
    if (event.kind === "tool_started" && typeof item.id === "string") {
      const itemType = String(item.type ?? "work"); const detail = compact(item.command ?? item.summary ?? item.text);
      active.set(item.id, { id: item.id, kind: itemType.includes("agent") ? "agent" : "tool", name: String(item.name ?? itemType.replaceAll("_", " ")), ...(detail ? { detail } : {}), ...(typeof event.recorded_at === "string" ? { startedAt: event.recorded_at } : {}) });
    }
    if (event.kind === "tool_completed" && typeof item.id === "string") active.delete(item.id);
  }
  return [...active.values()];
}
