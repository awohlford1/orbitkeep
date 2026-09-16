import type { JiraIntegrationConfiguration } from "../../contracts/configuration.ts";
import type { JiraReadAdapter, JiraWorkflowInspection, JiraWorkIntent } from "./types.ts";
import { JIRA_WORK_INTENTS } from "./types.ts";
import { planJiraTransition } from "./workflows.ts";
import { SystemJiraSecretStore, type JiraSecretStore } from "./secrets.ts";

export interface JiraCredentialResolution {
  available: boolean;
  source?: "environment" | "os_keychain";
  code?: "JIRA_CREDENTIAL_REFERENCE_MISSING" | "JIRA_CREDENTIAL_REFERENCE_UNSUPPORTED" | "JIRA_CREDENTIAL_UNAVAILABLE" | "JIRA_SECRET_STORE_UNAVAILABLE";
}

/** Resolves only an environment-variable reference; secret values never enter diagnostics output. */
export function resolveJiraCredential(reference: string | undefined, environment: NodeJS.ProcessEnv = process.env): JiraCredentialResolution & { authorization?: string } {
  if (!reference) return { available: false, code: "JIRA_CREDENTIAL_REFERENCE_MISSING" };
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
  if (!match) return { available: false, code: "JIRA_CREDENTIAL_REFERENCE_UNSUPPORTED" };
  const variableName = match[1];
  if (!variableName) return { available: false, code: "JIRA_CREDENTIAL_REFERENCE_UNSUPPORTED" };
  const authorization = environment[variableName];
  return authorization && authorization.trim().length > 0 ? { available: true, source: "environment", authorization } : { available: false, code: "JIRA_CREDENTIAL_UNAVAILABLE" };
}

/** Resolves an environment reference or a durable OS-keychain reference. Secret values are returned only to the caller. */
export async function resolveJiraCredentialAsync(reference: string | undefined, options: { environment?: NodeJS.ProcessEnv; secretStore?: JiraSecretStore } = {}): Promise<JiraCredentialResolution & { authorization?: string }> {
  const fromEnvironment = resolveJiraCredential(reference, options.environment);
  if (fromEnvironment.available || !reference?.startsWith("os-keychain:")) return fromEnvironment;
  try {
    const authorization = await (options.secretStore ?? new SystemJiraSecretStore()).get(reference);
    return authorization && authorization.trim().length > 0 ? { available: true, source: "os_keychain", authorization } : { available: false, code: "JIRA_CREDENTIAL_UNAVAILABLE" };
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === "JIRA_SECRET_STORE_UNAVAILABLE") return { available: false, code: "JIRA_SECRET_STORE_UNAVAILABLE" };
    throw error;
  }
}

export interface JiraConfigurationHealth {
  configured: boolean;
  mode: JiraIntegrationConfiguration["mode"];
  siteConfigured: boolean;
  credential: JiraCredentialResolution;
  projectKeys: readonly string[];
  workflowProfiles: readonly { id: string; projectKey: string; issueTypes: readonly string[]; mappedIntents: readonly JiraWorkIntent[] }[];
  warnings: readonly string[];
}

export function jiraConfigurationHealth(configuration: JiraIntegrationConfiguration, environment: NodeJS.ProcessEnv = process.env): JiraConfigurationHealth {
  const credential = resolveJiraCredential(configuration.credentialReference, environment);
  const warnings: string[] = [];
  if (configuration.enabled && !credential.available) warnings.push("Jira is enabled but its credential is unavailable. Configure integrations.jira.credentialReference as env:VARIABLE and set that environment variable before use.");
  if (configuration.enabled && !configuration.siteUrl) warnings.push("Jira is enabled but no siteUrl is configured.");
  return {
    configured: configuration.enabled, mode: configuration.mode, siteConfigured: typeof configuration.siteUrl === "string" && configuration.siteUrl.length > 0,
    credential: credential.available ? { available: true, source: "environment" } : credential,
    projectKeys: configuration.projectKeys,
    workflowProfiles: configuration.workflowProfiles.map((profile) => ({ id: profile.id, projectKey: profile.projectKey, issueTypes: profile.issueTypes, mappedIntents: JIRA_WORK_INTENTS.filter((intent) => profile.mappings[intent] !== undefined) })),
    warnings,
  };
}

export async function jiraConfigurationHealthAsync(configuration: JiraIntegrationConfiguration, options: { environment?: NodeJS.ProcessEnv; secretStore?: JiraSecretStore } = {}): Promise<JiraConfigurationHealth> {
  const credential = await resolveJiraCredentialAsync(configuration.credentialReference, options);
  const synchronous = jiraConfigurationHealth(configuration, options.environment);
  const warnings = synchronous.warnings.filter((warning) => !warning.startsWith("Jira is enabled but its credential"));
  if (configuration.enabled && !credential.available) warnings.push("Jira is enabled but its credential is unavailable. Run `orbitkeep jira configure` to store it securely, or configure an env: credential reference.");
  return { ...synchronous, credential: credential.available ? { available: true, source: credential.source! } : credential, warnings };
}

/** Fetches an issue and its currently legal direct transitions, then evaluates each configured intent without writing Jira. */
export async function inspectJiraWorkflow(input: { configuration: JiraIntegrationConfiguration; adapter: JiraReadAdapter; issueKey: string }): Promise<JiraWorkflowInspection> {
  const [issue, transitions] = await Promise.all([input.adapter.getIssue(input.issueKey), input.adapter.getAvailableTransitions(input.issueKey)]);
  const plans = Object.fromEntries(JIRA_WORK_INTENTS.map((intent) => [intent, planJiraTransition({ mode: input.configuration.mode, profiles: input.configuration.workflowProfiles, projectKey: issue.projectKey, issueType: issue.issueType, intent, currentStatus: issue.status, availableTransitions: transitions })])) as JiraWorkflowInspection["plans"];
  return { issue, transitions, plans };
}
