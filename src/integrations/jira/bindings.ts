import { coreSchemaRegistry } from "../../registries/index.ts";
import { resolveRecord, writeAssignmentRecord } from "../../storage/index.ts";
import type { StoredRecord } from "../../storage/index.ts";

export interface JiraTaskBinding { bindingId: string; assignmentId: string; taskId: string; issueKey: string; createdAt: string; }

function bindingId(taskId: string): string { return `wit-jira-${taskId}`; }
function validIssueKey(value: string): boolean { return /^[A-Z][A-Z0-9]+-\d+$/i.test(value); }

/** Persists a canonical work-item record; the Jira key itself is not a secret. */
export async function bindJiraTask(input: { stateRoot: string; assignmentId: string; taskId: string; issueKey: string; createdAt?: string }): Promise<JiraTaskBinding> {
  if (!validIssueKey(input.issueKey)) throw Object.assign(new Error("JIRA_ISSUE_KEY_INVALID"), { code: "JIRA_ISSUE_KEY_INVALID" });
  const createdAt = input.createdAt ?? new Date().toISOString(); const id = bindingId(input.taskId);
  const record: StoredRecord = {
    schema_version: "1.0", record_id: id, record_type: "work-item", created_at: createdAt,
    work_item_id: id, assignment_id: input.assignmentId, title: `Jira ${input.issueKey}`, external_ref: `jira:${input.issueKey.toUpperCase()}`, task_ids: [input.taskId],
  };
  await writeAssignmentRecord({ stateRoot: input.stateRoot, assignmentId: input.assignmentId, category: "work-items", record, immutable: true, validator: { validate: (_schema, value, version) => coreSchemaRegistry.validateRecord("work-item", value, version) }, schemaId: "work-item" });
  return { bindingId: id, assignmentId: input.assignmentId, taskId: input.taskId, issueKey: input.issueKey.toUpperCase(), createdAt };
}

export async function jiraTaskBinding(stateRoot: string, taskId: string): Promise<JiraTaskBinding | undefined> {
  const id = bindingId(taskId);
  try {
    const resolved = await resolveRecord(stateRoot, id);
    const record = resolved.record as Record<string, unknown>;
    const external = typeof record.external_ref === "string" ? /^jira:([A-Z][A-Z0-9]+-\d+)$/i.exec(record.external_ref) : undefined;
    if (!external?.[1] || !record.assignment_id || !Array.isArray(record.task_ids) || record.task_ids[0] !== taskId) return undefined;
    return { bindingId: id, assignmentId: String(record.assignment_id), taskId, issueKey: external[1].toUpperCase(), createdAt: String(record.created_at) };
  } catch (error) {
    if ((error as { code?: string }).code === "STATE_RECORD_NOT_FOUND") return undefined;
    throw error;
  }
}
