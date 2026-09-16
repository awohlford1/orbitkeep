import { AgentWorkflowError } from "../../contracts/errors.ts";
import type { JiraAdapter, JiraIssueSnapshot, JiraTransition, JiraTransitionRequest, JiraWorklogRequest } from "./types.ts";

export interface JiraCloudReadClientOptions {
  siteUrl: string;
  authorization: string;
  fetchImplementation?: typeof fetch;
}

export interface JiraCurrentUser { accountId: string; displayName?: string; }

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredText(value: unknown, path: string): string {
  const result = text(value);
  if (!result) throw new AgentWorkflowError({ code: "JIRA_RESPONSE_INVALID", message: `Jira returned an invalid ${path}.`, path });
  return result;
}

function parseSiteUrl(siteUrl: string): URL {
  let url: URL;
  try { url = new URL(siteUrl); } catch { throw new AgentWorkflowError({ code: "JIRA_SITE_URL_INVALID", message: "Jira siteUrl must be a valid HTTPS URL.", path: "integrations.jira.siteUrl" }); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new AgentWorkflowError({ code: "JIRA_SITE_URL_INVALID", message: "Jira siteUrl must be an HTTPS origin without credentials, query, or fragment.", path: "integrations.jira.siteUrl" });
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function joinApiPath(site: URL, apiPath: string): URL {
  return new URL(`${site.pathname}/rest/api/3/${apiPath}`.replace(/^\//, ""), `${site.origin}/`);
}

/** Jira Cloud REST client. Mutations are exposed only through governed intent execution. */
export class JiraCloudReadClient implements JiraAdapter {
  readonly #site: URL;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(options: JiraCloudReadClientOptions) {
    this.#site = parseSiteUrl(options.siteUrl);
    if (options.authorization.trim().length === 0) throw new AgentWorkflowError({ code: "JIRA_CREDENTIAL_UNAVAILABLE", message: "The Jira credential resolved to an empty value.", path: "integrations.jira.credentialReference" });
    this.#authorization = options.authorization;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async getIssue(issueKey: string): Promise<JiraIssueSnapshot> {
    const payload = await this.request(`issue/${encodeURIComponent(issueKey)}?fields=project,issuetype,status,updated`);
    const fields = object(payload.fields);
    const project = object(fields?.project); const issueType = object(fields?.issuetype); const status = object(fields?.status);
    const updatedAt = text(fields?.updated);
    return {
      issueKey: requiredText(payload.key, "key"),
      projectKey: requiredText(project?.key, "fields.project.key"),
      issueType: requiredText(issueType?.name, "fields.issuetype.name"),
      status: requiredText(status?.name, "fields.status.name"),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }

  async getCurrentUser(): Promise<JiraCurrentUser> {
    const payload = await this.request("myself");
    const displayName = text(payload.displayName);
    return { accountId: requiredText(payload.accountId, "accountId"), ...(displayName ? { displayName } : {}) };
  }

  async getAvailableTransitions(issueKey: string): Promise<readonly JiraTransition[]> {
    const payload = await this.request(`issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`);
    if (!Array.isArray(payload.transitions)) throw new AgentWorkflowError({ code: "JIRA_RESPONSE_INVALID", message: "Jira returned an invalid transitions response.", path: "transitions" });
    return payload.transitions.map((value, index) => {
      const item = object(value); const to = object(item?.to); const fields = object(item?.fields);
      const requiredFields = Object.entries(fields ?? {}).filter(([, definition]) => object(definition)?.required === true).map(([field]) => field);
      return {
        id: requiredText(item?.id, `transitions.${index}.id`),
        name: requiredText(item?.name, `transitions.${index}.name`),
        toStatus: requiredText(to?.name, `transitions.${index}.to.name`),
        ...(requiredFields.length > 0 ? { requiredFields } : {}),
      };
    });
  }

  async transitionIssue(request: JiraTransitionRequest): Promise<JiraIssueSnapshot> {
    await this.request(`issue/${encodeURIComponent(request.issueKey)}/transitions`, {
      method: "POST",
      body: { transition: { id: request.transitionId }, ...(request.fields === undefined ? {} : { fields: request.fields }) },
    });
    return this.getIssue(request.issueKey);
  }

  async addComment(issueKey: string, body: string, _idempotencyKey: string): Promise<void> {
    await this.request(`issue/${encodeURIComponent(issueKey)}/comment`, { method: "POST", body: { body: adfText(body) } });
  }

  async addWorklog(request: JiraWorklogRequest): Promise<void> {
    await this.request(`issue/${encodeURIComponent(request.issueKey)}/worklog`, { method: "POST", body: { started: request.startedAt, timeSpentSeconds: request.durationSeconds, comment: adfText(request.comment) } });
  }

  async request(path: string, options: { method?: "POST"; body?: JsonObject } = {}): Promise<JsonObject> {
    const response = await this.#fetch(joinApiPath(this.#site, path), {
      ...(options.method === undefined ? {} : { method: options.method }),
      headers: { Accept: "application/json", Authorization: this.#authorization, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }).catch((cause: unknown) => {
      throw new AgentWorkflowError({ code: "JIRA_REQUEST_FAILED", message: "The Jira request could not be completed." }, { cause });
    });
    if (!response.ok) throw new AgentWorkflowError({ code: "JIRA_REQUEST_REJECTED", message: `Jira rejected the request (HTTP ${response.status}).`, details: { status: response.status } });
    if (response.status === 204) return {};
    const body: unknown = await response.json().catch((cause: unknown) => { throw new AgentWorkflowError({ code: "JIRA_RESPONSE_INVALID", message: "Jira returned invalid JSON." }, { cause }); });
    const payload = object(body);
    if (!payload) throw new AgentWorkflowError({ code: "JIRA_RESPONSE_INVALID", message: "Jira returned an invalid response body." });
    return payload;
  }
}

function adfText(textValue: string): JsonObject {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: textValue }] }] };
}
