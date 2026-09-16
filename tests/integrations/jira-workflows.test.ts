import assert from "node:assert/strict";
import test from "node:test";
import { planJiraTransition, selectJiraWorkflowProfile, type JiraWorkflowProfile } from "orbitkeep/integrations/jira";

const profiles: JiraWorkflowProfile[] = [{
  id: "pay-story",
  projectKey: "PAY",
  issueTypes: ["Story", "Task"],
  mappings: {
    work_started: { targetStatus: "Development", authority: "automatic", fallback: "pending" },
    work_completed: { targetStatus: "Ready for Product Review", authority: "executive", fallback: "propose" },
    work_blocked: { authority: "automatic", fallback: "comment_only" },
  },
}, {
  id: "pay-default",
  projectKey: "PAY",
  issueTypes: ["*"],
  mappings: { work_started: { targetStatus: "In Progress", authority: "automatic", fallback: "pending" } },
}];

test("custom workflow profiles prefer an exact issue-type mapping over a wildcard", () => {
  assert.equal(selectJiraWorkflowProfile(profiles, "pay", "story")?.id, "pay-story");
  assert.equal(selectJiraWorkflowProfile(profiles, "PAY", "Bug")?.id, "pay-default");
});

test("observe mode plans a direct custom Jira transition without applying it", () => {
  const plan = planJiraTransition({
    mode: "observe", profiles, projectKey: "PAY", issueType: "Story", intent: "work_started",
    currentStatus: "Selected",
    availableTransitions: [{ id: "31", name: "Begin development", toStatus: "Development" }],
  });
  assert.equal(plan.disposition, "observe");
  assert.equal(plan.transition?.id, "31");
});

test("planner does not guess or walk through unavailable intermediate statuses", () => {
  const plan = planJiraTransition({
    mode: "automatic", profiles, projectKey: "PAY", issueType: "Story", intent: "work_started",
    currentStatus: "Selected",
    availableTransitions: [{ id: "18", name: "Triage", toStatus: "Triaged" }],
  });
  assert.deepEqual(plan, {
    disposition: "pending", reason: "transition_unavailable", profileId: "pay-story", targetStatus: "Development",
  });
});

test("missing optional status uses the configured comment-only fallback", () => {
  const plan = planJiraTransition({
    mode: "automatic", profiles, projectKey: "PAY", issueType: "Story", intent: "work_blocked",
    currentStatus: "Development", availableTransitions: [],
  });
  assert.equal(plan.disposition, "comment_only");
});

test("executive authority and required fields prevent automatic transition", () => {
  const missing = planJiraTransition({
    mode: "automatic", profiles, projectKey: "PAY", issueType: "Story", intent: "work_completed",
    currentStatus: "Development",
    availableTransitions: [{ id: "42", name: "Submit", toStatus: "Ready for Product Review", requiredFields: ["fixVersion"] }],
  });
  assert.equal(missing.reason, "required_fields_missing");
  assert.deepEqual(missing.missingFields, ["fixVersion"]);

  const approval = planJiraTransition({
    mode: "automatic", profiles, projectKey: "PAY", issueType: "Story", intent: "work_completed",
    currentStatus: "Development",
    availableTransitions: [{ id: "42", name: "Submit", toStatus: "Ready for Product Review" }],
  });
  assert.equal(approval.disposition, "propose");
  assert.equal(approval.reason, "authority_required");
});
