import type { SettingAuthority } from "../contracts/configuration.ts";

const projectOnly = (path: string): SettingAuthority => ({
  path,
  projectOverridable: true,
  assignmentOverridable: false,
  executiveWaivable: false,
});

const projectAndAssignment = (path: string): SettingAuthority => ({
  path,
  projectOverridable: true,
  assignmentOverridable: true,
  executiveWaivable: false,
});

const waivable = (path: string): SettingAuthority => ({
  path,
  projectOverridable: true,
  assignmentOverridable: false,
  executiveWaivable: true,
});

export const SETTING_AUTHORITIES: readonly SettingAuthority[] = [
  projectOnly("schemaVersion"),
  projectOnly("framework.minimumVersion"),
  projectOnly("state.directory"),
  waivable("approvals.initialPlan"),
  waivable("approvals.resumePlan"),
  waivable("approvals.materialPlanChange"),
  projectOnly("intentLogging.retryCount"),
  projectOnly("intentLogging.backoffSeconds"),
  projectOnly("referenceValidation.retrySeconds"),
  projectOnly("referenceValidation.timeoutSeconds"),
  projectAndAssignment("heartbeat.enabled"),
  projectAndAssignment("heartbeat.intervalSeconds"),
  projectOnly("supervisor.idleTimeoutSeconds"),
  projectOnly("retention.rawResponsesDays"),
  projectOnly("retention.closedAssignmentsDays"),
  projectOnly("retention.installationBackupsDays"),
  {
    path: "retention.permanentArchiveDeletion",
    projectOverridable: false,
    assignmentOverridable: false,
    executiveWaivable: false,
  },
  projectOnly("execution.defaultInterruptionMode"),
  projectAndAssignment("execution.retryPolicy.maxAttempts"),
  projectAndAssignment("execution.retryPolicy.backoffSeconds"),
  {
    path: "execution.automaticForceEscalation",
    projectOverridable: false,
    assignmentOverridable: false,
    executiveWaivable: false,
  },
  projectAndAssignment("roles.enabled"),
  projectOnly("materiality.alwaysMaterial"),
  projectOnly("materiality.delegatedChanges"),
  projectOnly("materiality.cumulativeChangeThreshold"),
  projectOnly("materiality.ambiguityBehavior"),
  projectAndAssignment("models.selectionAuthority"),
  projectAndAssignment("models.fallback"),
  projectAndAssignment("models.roles.*.allowed"),
  projectOnly("providers.*.enabled"),
  projectOnly("providers.*.requiredMode"),
  projectOnly("providers.*.captureRawResponses"),
  projectOnly("integrations.jira.enabled"),
  projectOnly("integrations.jira.mode"),
  projectOnly("integrations.jira.siteUrl"),
  projectOnly("integrations.jira.credentialReference"),
  projectOnly("integrations.jira.projectKeys"),
  projectOnly("integrations.jira.workflowProfiles"),
  projectOnly("integrations.jira.scrumAgent.enabled"),
  projectOnly("integrations.jira.scrumAgent.progressComments"),
  projectOnly("integrations.jira.scrumAgent.progressIntervalMinutes"),
  projectOnly("integrations.jira.scrumAgent.timeTracking"),
  projectOnly("integrations.jira.scrumAgent.estimateUpdates"),
  projectOnly("silo.credentialProvider"),
  projectOnly("silo.registration.required"),
  projectOnly("silo.registration.trustedAuthorityKeys.*"),
  projectOnly("security.executiveApproval.mode"),
  projectOnly("security.executiveApproval.trustedPublicKeys.*"),
  projectOnly("security.executiveApproval.receiptMaxAgeSeconds"),
  {
    path: "security.stateRootContainment",
    projectOverridable: false,
    assignmentOverridable: false,
    executiveWaivable: false,
  },
  {
    path: "security.secretRedaction",
    projectOverridable: false,
    assignmentOverridable: false,
    executiveWaivable: false,
  },
  {
    path: "security.executeRecordContent",
    projectOverridable: false,
    assignmentOverridable: false,
    executiveWaivable: false,
  },
] as const;

export function authorityForPath(path: string): SettingAuthority | undefined {
  const parts = path.split(".");
  return SETTING_AUTHORITIES.find((entry) => {
    const expected = entry.path.split(".");
    return expected.length === parts.length
      && expected.every((part, index) => part === "*" || part === parts[index]);
  });
}
