import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentWorkflowError } from "orbitkeep/contracts";
import { JiraCloudReadClient, SystemJiraSecretStore, bindJiraTask, executeJiraIntent, inspectJiraWorkflow, jiraConfigurationHealth, jiraConfigurationHealthAsync, jiraKeychainReference, jiraTaskBinding, resolveJiraCredential, resolveJiraCredentialAsync } from "orbitkeep/integrations/jira";
import { initializeStateRoot } from "orbitkeep/storage";
import type { JiraIntegrationConfiguration } from "../../src/contracts/configuration.ts";

const configuration: JiraIntegrationConfiguration = {
  enabled: true,
  mode: "observe",
  siteUrl: "https://example.atlassian.net",
  credentialReference: "env:ORBITKEEP_JIRA_AUTHORIZATION",
  projectKeys: ["PAY"],
  workflowProfiles: [{ id: "pay", projectKey: "PAY", issueTypes: ["Story"], mappings: { work_started: { targetStatus: "In Progress", authority: "automatic", fallback: "pending" } } }],
  scrumAgent: { enabled: false, progressComments: true, progressIntervalMinutes: 30, timeTracking: "disabled", estimateUpdates: "propose" },
};

test("Jira Cloud read client fetches an issue and its legal direct transitions without mutations", async () => {
  const requests: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
  const client = new JiraCloudReadClient({
    siteUrl: configuration.siteUrl!, authorization: "Basic secret-value",
    fetchImplementation: async (input, init) => {
      requests.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get("Authorization") });
      if (String(input).includes("/transitions")) return new Response(JSON.stringify({ transitions: [{ id: "21", name: "Start", to: { name: "In Progress" }, fields: { customfield_12: { required: true }, summary: { required: false } } }] }), { status: 200 });
      return new Response(JSON.stringify({ key: "PAY-123", fields: { project: { key: "PAY" }, issuetype: { name: "Story" }, status: { name: "To Do" }, updated: "2026-09-15T00:00:00.000Z" } }), { status: 200 });
    },
  });
  const [issue, transitions] = await Promise.all([client.getIssue("PAY-123"), client.getAvailableTransitions("PAY-123")]);
  assert.deepEqual(issue, { issueKey: "PAY-123", projectKey: "PAY", issueType: "Story", status: "To Do", updatedAt: "2026-09-15T00:00:00.000Z" });
  assert.deepEqual(transitions, [{ id: "21", name: "Start", toStatus: "In Progress", requiredFields: ["customfield_12"] }]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === undefined && request.authorization === "Basic secret-value"));
  assert.ok(requests.every((request) => request.url.startsWith("https://example.atlassian.net/rest/api/3/")));
});

test("Jira client reports request failures without exposing credentials", async () => {
  const client = new JiraCloudReadClient({ siteUrl: configuration.siteUrl!, authorization: "Bearer definitely-secret", fetchImplementation: async () => new Response("forbidden", { status: 403 }) });
  await assert.rejects(client.getIssue("PAY-1"), (error: unknown) => {
    assert.ok(error instanceof AgentWorkflowError);
    assert.equal(error.code, "JIRA_REQUEST_REJECTED");
    assert.doesNotMatch(error.message, /definitely-secret/);
    return true;
  });
});

test("Jira client sends transition, comment, and worklog writes as explicit POST requests", async () => {
  const writes: Array<{ path: string; body: unknown }> = [];
  const client = new JiraCloudReadClient({
    siteUrl: configuration.siteUrl!, authorization: "Basic secret-value",
    fetchImplementation: async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") { writes.push({ path: url, body: init.body ? JSON.parse(String(init.body)) : undefined }); return new Response(null, { status: 204 }); }
      return new Response(JSON.stringify({ key: "PAY-123", fields: { project: { key: "PAY" }, issuetype: { name: "Story" }, status: { name: "In Progress" } } }), { status: 200 });
    },
  });
  await client.transitionIssue({ issueKey: "PAY-123", transitionId: "21", fields: { fixVersion: "1.0" }, idempotencyKey: "idempotency-1" });
  await client.addComment("PAY-123", "Work started", "idempotency-2");
  await client.addWorklog({ issueKey: "PAY-123", startedAt: "2026-09-15T12:00:00.000Z", durationSeconds: 60, comment: "One minute", idempotencyKey: "idempotency-3" });
  assert.deepEqual(writes.map((entry) => new URL(entry.path).pathname), ["/rest/api/3/issue/PAY-123/transitions", "/rest/api/3/issue/PAY-123/comment", "/rest/api/3/issue/PAY-123/worklog"]);
  assert.deepEqual(writes[0]?.body, { transition: { id: "21" }, fields: { fixVersion: "1.0" } });
  assert.deepEqual(writes[1]?.body, { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Work started" }] }] } });
  assert.equal((writes[2]?.body as { timeSpentSeconds: number }).timeSpentSeconds, 60);
});

test("Jira doctor health resolves only a referenced environment secret and never returns its value", () => {
  assert.deepEqual(resolveJiraCredential("env:ORBITKEEP_JIRA_AUTHORIZATION", { ORBITKEEP_JIRA_AUTHORIZATION: "Bearer hidden" }), { available: true, source: "environment", authorization: "Bearer hidden" });
  const health = jiraConfigurationHealth(configuration, { ORBITKEEP_JIRA_AUTHORIZATION: "Bearer hidden" });
  assert.equal(health.credential.available, true);
  assert.equal(JSON.stringify(health), JSON.stringify(health).replace("hidden", ""));
  assert.equal(health.workflowProfiles[0]?.mappedIntents[0], "work_started");
});

test("durable Jira references use an OS credential store and do not put secret material in health output", async () => {
  const reference = jiraKeychainReference("https://example.atlassian.net");
  assert.equal(reference, "os-keychain:orbitkeep/jira/example.atlassian.net");
  const store = {
    platform: "win32" as const,
    async put() {}, async remove() {}, async get() { return "Bearer stored-secret"; },
  };
  const resolved = await resolveJiraCredentialAsync(reference, { secretStore: store });
  assert.equal(resolved.authorization, "Bearer stored-secret");
  const health = await jiraConfigurationHealthAsync({ ...configuration, credentialReference: reference }, { secretStore: store });
  assert.equal(health.credential.source, "os_keychain");
  assert.doesNotMatch(JSON.stringify(health), /stored-secret/);
});

test("Windows keychain adapter sends the secret through standard input rather than command arguments", async () => {
  let captured: { command: string; args: readonly string[]; input?: string } | undefined;
  const store = new SystemJiraSecretStore({ platform: "win32", run: async (command, args, input) => {
    captured = { command, args, ...(input === undefined ? {} : { input }) };
    return { stdout: "", stderr: "", exitCode: 0 };
  } });
  await store.put("os-keychain:orbitkeep/jira/example.atlassian.net", "Basic private-value");
  assert.equal(captured?.command, "powershell.exe");
  assert.equal(captured?.input, "Basic private-value");
  assert.ok(!captured?.args.includes("Basic private-value"));
});

test("workflow inspection evaluates all semantic intents against live read-only data", async () => {
  const inspection = await inspectJiraWorkflow({ configuration, issueKey: "PAY-123", adapter: {
    async getIssue() { return { issueKey: "PAY-123", projectKey: "PAY", issueType: "Story", status: "To Do" }; },
    async getAvailableTransitions() { return [{ id: "21", name: "Start", toStatus: "In Progress" }]; },
  } });
  assert.equal(inspection.plans.work_started.disposition, "observe");
  assert.equal(inspection.plans.work_started.transition?.id, "21");
  assert.equal(inspection.plans.work_completed.reason, "mapping_not_found");
});

test("automatic mode applies only an exact, freshly-read direct transition and confirms its result", async () => {
  let transitionId: string | undefined;
  const result = await executeJiraIntent({
    configuration: { ...configuration, mode: "automatic" }, issueKey: "PAY-123", intent: "work_started",
    adapter: {
      async getIssue() { return { issueKey: "PAY-123", projectKey: "PAY", issueType: "Story", status: transitionId ? "In Progress" : "To Do" }; },
      async getAvailableTransitions() { return [{ id: "21", name: "Start", toStatus: "In Progress" }]; },
      async transitionIssue(request) { transitionId = request.transitionId; return { issueKey: "PAY-123", projectKey: "PAY", issueType: "Story", status: "In Progress" }; },
      async addComment() {}, async addWorklog() {},
    },
  });
  assert.equal(transitionId, "21");
  assert.equal(result.status, "transitioned");
  assert.equal(result.afterStatus, "In Progress");
});

test("governed execution never writes for a proposal, missing required fields, or an unallowlisted project", async () => {
  let writes = 0;
  const adapter = {
    async getIssue() { return { issueKey: "OTHER-1", projectKey: "OTHER", issueType: "Story", status: "To Do" }; },
    async getAvailableTransitions() { return [{ id: "21", name: "Start", toStatus: "In Progress", requiredFields: ["fixVersion"] }]; },
    async transitionIssue() { writes += 1; return { issueKey: "OTHER-1", projectKey: "OTHER", issueType: "Story", status: "In Progress" }; },
    async addComment() { writes += 1; }, async addWorklog() { writes += 1; },
  };
  await assert.rejects(executeJiraIntent({ configuration: { ...configuration, mode: "automatic" }, adapter, issueKey: "OTHER-1", intent: "work_started" }), { code: "JIRA_PROJECT_NOT_ALLOWED" });
  assert.equal(writes, 0);
  const proposed = await executeJiraIntent({ configuration: { ...configuration, mode: "propose", projectKeys: ["OTHER"] }, adapter, issueKey: "OTHER-1", intent: "work_started" });
  assert.equal(proposed.status, "proposed");
  assert.equal(writes, 0);
});

test("a Jira issue binding is a durable canonical work-item record tied to one task", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-jira-binding-"));
  const { stateRoot } = await initializeStateRoot(root, ".agent-state");
  const binding = await bindJiraTask({ stateRoot, assignmentId: "asn-binding-test", taskId: "tsk-binding-test", issueKey: "PAY-42", createdAt: "2026-09-15T00:00:00.000Z" });
  assert.equal(binding.issueKey, "PAY-42");
  assert.deepEqual(await jiraTaskBinding(stateRoot, "tsk-binding-test"), binding);
  await assert.rejects(bindJiraTask({ stateRoot, assignmentId: "asn-binding-test", taskId: "tsk-other", issueKey: "not-a-jira-key" }), { code: "JIRA_ISSUE_KEY_INVALID" });
});
