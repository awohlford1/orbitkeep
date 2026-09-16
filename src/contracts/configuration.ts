import type { JiraIntegrationMode, JiraWorkflowProfile } from "../integrations/jira/types.ts";

export type ApprovalRequirement = "required" | "not_required";
export type InterruptionMode = "graceful" | "force";
export type AmbiguityBehavior = "hold_affected_work";
export type ModelFallbackPolicy = "require_authorization" | "reject";
export type ProviderRequiredMode = "off" | "instructions" | "observed" | "enforced" | "brokered";

export interface JiraScrumAgentConfiguration {
  enabled: boolean;
  progressComments: boolean;
  progressIntervalMinutes: number;
  timeTracking: "disabled" | "observe" | "automatic";
  estimateUpdates: "disabled" | "propose" | "automatic";
}

export interface JiraIntegrationConfiguration {
  enabled: boolean;
  mode: JiraIntegrationMode;
  siteUrl?: string;
  credentialReference?: string;
  projectKeys: string[];
  workflowProfiles: JiraWorkflowProfile[];
  scrumAgent: JiraScrumAgentConfiguration;
}

export interface FrameworkConfiguration {
  schemaVersion: "1.0";
  framework: { minimumVersion: string };
  state: { directory: string };
  approvals: {
    initialPlan: ApprovalRequirement;
    resumePlan: ApprovalRequirement;
    materialPlanChange: ApprovalRequirement;
  };
  intentLogging: { retryCount: number; backoffSeconds: number[] };
  referenceValidation: { retrySeconds: number[]; timeoutSeconds: number };
  heartbeat: { enabled: boolean; intervalSeconds: number };
  supervisor: { idleTimeoutSeconds: number };
  retention: {
    rawResponsesDays: number;
    closedAssignmentsDays: number;
    installationBackupsDays: number;
    permanentArchiveDeletion: false;
  };
  execution: {
    defaultInterruptionMode: InterruptionMode;
    automaticForceEscalation: false;
    retryPolicy: { maxAttempts: number; backoffSeconds: number[] };
  };
  roles: { enabled: string[] };
  materiality: {
    alwaysMaterial: string[];
    delegatedChanges: string[];
    cumulativeChangeThreshold: number;
    ambiguityBehavior: AmbiguityBehavior;
  };
  models: {
    selectionAuthority: ("executive" | "manager_policy")[];
    fallback: ModelFallbackPolicy;
    roles: Record<string, { allowed: string[] }>;
  };
  providers: Record<string, {
    enabled: boolean;
    requiredMode?: ProviderRequiredMode;
    captureRawResponses?: boolean;
  }>;
  integrations: { jira: JiraIntegrationConfiguration };
  silo: {
    credentialProvider: "none" | "local_file_degraded";
    registration: { required: boolean; trustedAuthorityKeys: Record<string, string> };
  };
  security: {
    stateRootContainment: true;
    secretRedaction: true;
    executeRecordContent: false;
    executiveApproval: {
      mode: "record_only" | "signed_ed25519";
      trustedPublicKeys: Record<string, string>;
      receiptMaxAgeSeconds: number;
    };
  };
}

export interface MachineLocalConfiguration {
  machineId?: string;
  providerExecutables?: Record<string, string>;
  cacheDirectory?: string;
  scheduler?: { enabled?: boolean };
  concurrency?: { maxOperations?: number };
  secretReferences?: Record<string, string>;
}

export interface ConfigurationExtension {
  namespace: string;
  version: string;
  config: Readonly<Record<string, unknown>>;
}

export type OverrideAuthority = "project" | "assignment" | "executive";

export interface SettingAuthority {
  path: string;
  projectOverridable: boolean;
  assignmentOverridable: boolean;
  executiveWaivable: boolean;
}

export interface EffectiveConfiguration {
  config: Readonly<FrameworkConfiguration>;
  extensions: Readonly<Record<string, ConfigurationExtension>>;
  machine: Readonly<MachineLocalConfiguration>;
  digest: string;
}
