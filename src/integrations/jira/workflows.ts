import type {
  JiraIntegrationMode,
  JiraTransition,
  JiraTransitionFallback,
  JiraTransitionPlan,
  JiraWorkflowProfile,
  JiraWorkIntent,
} from "./types.ts";

export interface PlanJiraTransitionInput {
  mode: JiraIntegrationMode;
  profiles: readonly JiraWorkflowProfile[];
  projectKey: string;
  issueType: string;
  intent: JiraWorkIntent;
  currentStatus: string;
  availableTransitions: readonly JiraTransition[];
  providedFields?: Readonly<Record<string, unknown>>;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function selectJiraWorkflowProfile(
  profiles: readonly JiraWorkflowProfile[],
  projectKey: string,
  issueType: string,
): JiraWorkflowProfile | undefined {
  const project = profiles.filter((profile) => normalized(profile.projectKey) === normalized(projectKey));
  const exact = project.filter((profile) => profile.issueTypes.some((entry) => normalized(entry) === normalized(issueType)));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const wildcard = project.filter((profile) => profile.issueTypes.includes("*"));
  return wildcard.length === 1 ? wildcard[0] : undefined;
}

function fallbackDisposition(fallback: JiraTransitionFallback): JiraTransitionPlan["disposition"] {
  return fallback === "ignore" ? "none" : fallback;
}

export function planJiraTransition(input: PlanJiraTransitionInput): JiraTransitionPlan {
  if (input.mode === "disabled") return { disposition: "none", reason: "integration_disabled" };
  const profile = selectJiraWorkflowProfile(input.profiles, input.projectKey, input.issueType);
  if (!profile) return { disposition: "propose", reason: "profile_not_found" };
  const mapping = profile.mappings[input.intent];
  if (!mapping) return { disposition: "none", reason: "mapping_not_found", profileId: profile.id };
  if (mapping.authority === "prohibited") {
    return { disposition: "none", reason: "authority_required", profileId: profile.id };
  }

  const targetStatus = mapping.targetStatus;
  if (!targetStatus) {
    return { disposition: fallbackDisposition(mapping.fallback), reason: "transition_unavailable", profileId: profile.id };
  }
  if (normalized(input.currentStatus) === normalized(targetStatus)) {
    return { disposition: "none", reason: "already_at_target", profileId: profile.id, targetStatus };
  }

  const candidates = input.availableTransitions.filter((transition) => normalized(transition.toStatus) === normalized(targetStatus));
  if (candidates.length !== 1) {
    return {
      disposition: fallbackDisposition(mapping.fallback),
      reason: candidates.length === 0 ? "transition_unavailable" : "transition_ambiguous",
      profileId: profile.id,
      targetStatus,
    };
  }

  const transition = candidates[0];
  if (!transition) throw new Error("Jira transition planning invariant violated.");
  const fields = input.providedFields ?? {};
  const missingFields = (transition.requiredFields ?? []).filter((field) => fields[field] === undefined);
  if (missingFields.length > 0) {
    return {
      disposition: "propose",
      reason: "required_fields_missing",
      profileId: profile.id,
      targetStatus,
      transition,
      missingFields,
    };
  }
  if (input.mode === "observe") {
    return { disposition: "observe", reason: "ready", profileId: profile.id, targetStatus, transition };
  }
  if (input.mode === "propose" || mapping.authority === "executive") {
    return { disposition: "propose", reason: "authority_required", profileId: profile.id, targetStatus, transition };
  }
  return { disposition: "apply", reason: "ready", profileId: profile.id, targetStatus, transition };
}
