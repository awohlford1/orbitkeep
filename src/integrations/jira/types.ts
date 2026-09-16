export const JIRA_INTEGRATION_MODES = ["disabled", "observe", "propose", "automatic"] as const;
export type JiraIntegrationMode = typeof JIRA_INTEGRATION_MODES[number];

export const JIRA_WORK_INTENTS = [
  "work_started", "work_blocked", "work_resumed", "rework_requested",
  "work_completed", "work_cancelled", "work_paused",
] as const;
export type JiraWorkIntent = typeof JIRA_WORK_INTENTS[number];

export const JIRA_ACTION_AUTHORITIES = ["automatic", "executive", "prohibited"] as const;
export type JiraActionAuthority = typeof JIRA_ACTION_AUTHORITIES[number];
export const JIRA_TRANSITION_FALLBACKS = ["comment_only", "propose", "pending", "fail", "ignore"] as const;
export type JiraTransitionFallback = typeof JIRA_TRANSITION_FALLBACKS[number];

export interface JiraWorkflowMapping { targetStatus?: string; authority: JiraActionAuthority; fallback: JiraTransitionFallback }
export interface JiraWorkflowProfile {
  id: string;
  projectKey: string;
  issueTypes: string[];
  mappings: Partial<Record<JiraWorkIntent, JiraWorkflowMapping>>;
}
export interface JiraReadAdapter {
  getIssue(issueKey: string): Promise<JiraIssueSnapshot>;
  getAvailableTransitions(issueKey: string): Promise<readonly JiraTransition[]>;
}
export interface JiraTransition { id: string; name: string; toStatus: string; requiredFields?: string[] }
export interface JiraIssueSnapshot { issueKey: string; projectKey: string; issueType: string; status: string; updatedAt?: string }
export interface JiraTransitionRequest {
  issueKey: string;
  transitionId: string;
  fields?: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
}
export interface JiraWorklogRequest {
  issueKey: string;
  startedAt: string;
  durationSeconds: number;
  comment: string;
  idempotencyKey: string;
}
export interface JiraAdapter extends JiraReadAdapter {
  transitionIssue(request: JiraTransitionRequest): Promise<JiraIssueSnapshot>;
  addComment(issueKey: string, body: string, idempotencyKey: string): Promise<void>;
  addWorklog(request: JiraWorklogRequest): Promise<void>;
}
export interface JiraWorkflowInspection {
  issue: JiraIssueSnapshot;
  transitions: readonly JiraTransition[];
  plans: Readonly<Record<JiraWorkIntent, JiraTransitionPlan>>;
}
export type JiraTransitionPlanReason = "integration_disabled" | "profile_not_found" | "mapping_not_found"
  | "already_at_target" | "transition_unavailable" | "transition_ambiguous" | "required_fields_missing"
  | "authority_required" | "ready";
export type JiraTransitionPlanDisposition = "none" | "observe" | "propose" | "apply"
  | "comment_only" | "pending" | "fail";
export interface JiraTransitionPlan {
  disposition: JiraTransitionPlanDisposition;
  reason: JiraTransitionPlanReason;
  profileId?: string;
  targetStatus?: string;
  transition?: JiraTransition;
  missingFields?: string[];
}
