import { randomUUID } from "node:crypto";
import { AgentWorkflowError } from "../../contracts/errors.ts";
import type { JiraIntegrationConfiguration } from "../../contracts/configuration.ts";
import type { JiraAdapter, JiraTransitionPlan, JiraWorkIntent } from "./types.ts";
import { planJiraTransition } from "./workflows.ts";

export interface ExecuteJiraIntentInput {
  configuration: JiraIntegrationConfiguration;
  adapter: JiraAdapter;
  issueKey: string;
  intent: JiraWorkIntent;
  fields?: Readonly<Record<string, unknown>>;
  /** Required only for the configured comment-only fallback; no generated agent text is accepted implicitly. */
  comment?: string;
  idempotencyKey?: string;
}

export interface JiraIntentExecution {
  status: "not_applicable" | "observed" | "proposed" | "pending" | "transitioned" | "commented";
  plan: JiraTransitionPlan;
  issueKey: string;
  beforeStatus: string;
  afterStatus?: string;
}

/** Applies one freshly-read, exact direct transition. It never retries a mutation after an ambiguous result. */
export async function executeJiraIntent(input: ExecuteJiraIntentInput): Promise<JiraIntentExecution> {
  const [issue, transitions] = await Promise.all([input.adapter.getIssue(input.issueKey), input.adapter.getAvailableTransitions(input.issueKey)]);
  if (!input.configuration.projectKeys.some((key) => key.localeCompare(issue.projectKey, undefined, { sensitivity: "accent" }) === 0)) {
    throw new AgentWorkflowError({ code: "JIRA_PROJECT_NOT_ALLOWED", message: `Jira issue ${issue.issueKey} is outside the configured project allowlist.` });
  }
  const plan = planJiraTransition({ mode: input.configuration.mode, profiles: input.configuration.workflowProfiles, projectKey: issue.projectKey, issueType: issue.issueType, intent: input.intent, currentStatus: issue.status, availableTransitions: transitions, ...(input.fields === undefined ? {} : { providedFields: input.fields }) });
  const base = { plan, issueKey: issue.issueKey, beforeStatus: issue.status };
  if (plan.disposition === "none") return { status: "not_applicable", ...base };
  if (plan.disposition === "observe") return { status: "observed", ...base };
  if (plan.disposition === "propose" || plan.disposition === "fail") return { status: "proposed", ...base };
  if (plan.disposition === "pending") return { status: "pending", ...base };
  if (plan.disposition === "comment_only") {
    if (!input.comment) return { status: "pending", ...base };
    await input.adapter.addComment(issue.issueKey, input.comment, input.idempotencyKey ?? `jira-${randomUUID()}`);
    return { status: "commented", ...base };
  }
  if (!plan.transition || !plan.targetStatus) throw new AgentWorkflowError({ code: "JIRA_TRANSITION_PLAN_INVALID", message: "Jira transition plan did not include an exact target transition." });
  const after = await input.adapter.transitionIssue({ issueKey: issue.issueKey, transitionId: plan.transition.id, ...(input.fields === undefined ? {} : { fields: input.fields }), idempotencyKey: input.idempotencyKey ?? `jira-${randomUUID()}` });
  if (after.status.localeCompare(plan.targetStatus, undefined, { sensitivity: "accent" }) !== 0) {
    throw new AgentWorkflowError({ code: "JIRA_TRANSITION_UNCONFIRMED", message: "Jira accepted the transition request but the target status could not be confirmed. Do not retry automatically; reconcile the issue first." });
  }
  return { status: "transitioned", ...base, afterStatus: after.status };
}
