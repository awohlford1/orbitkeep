import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACTOR_TYPES,
  OPERATION_OUTCOMES,
} from "orbitkeep/contracts";
import { configurationDigest as publicConfigurationDigest } from "orbitkeep/config";
import { FRAMEWORK_VERSION, planUpgrade as publicPlanUpgrade } from "orbitkeep";
import { AgentWorkflowError } from "../../src/contracts/errors.ts";
import {
  loadEffectiveConfiguration,
  SETTING_AUTHORITIES,
} from "../../src/config/index.ts";

async function project(files: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-workflow-config-"));
  for (const [relativePath, value] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  return root;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AgentWorkflowError ? error.code : undefined;
}

test("package subpath exports expose the downstream interface baseline", () => {
  assert.ok(ACTOR_TYPES.includes("manager"));
  assert.ok(OPERATION_OUTCOMES.includes("prevented"));
  assert.match(publicConfigurationDigest({ stable: true }), /^sha256:[a-f0-9]{64}$/);
});

test("public package subpaths change only through an explicit contract update", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports), [
    ".",
    "./contracts",
    "./config",
    "./policy",
    "./commands",
    "./storage",
    "./evidence",
    "./providers/claude",
    "./providers/codex",
    "./installer",
    "./integrations/jira",
    "./scheduling",
    "./workflows",
    "./schemas/workflow-template.json",
    "./schemas/relay-envelope.json",
    "./schemas/charter.json",
    "./templates/software-delivery.json",
    "./silo",
    "./relay",
    "./defaults/config.json",
  ]);
});

test("package root export is generated and exposes versioned installer APIs", () => {
  assert.equal(FRAMEWORK_VERSION, "0.5.0");
  assert.equal(typeof publicPlanUpgrade, "function");
});

test("ratified defaults load without consumer configuration", async () => {
  const effective = await loadEffectiveConfiguration({ projectRoot: await project() });

  assert.equal(effective.config.approvals.initialPlan, "required");
  assert.equal(effective.config.approvals.resumePlan, "required");
  assert.equal(effective.config.approvals.materialPlanChange, "required");
  assert.deepEqual(effective.config.intentLogging.backoffSeconds, [1, 2, 4]);
  assert.deepEqual(effective.config.referenceValidation.retrySeconds, [5, 15, 30]);
  assert.equal(effective.config.referenceValidation.timeoutSeconds, 60);
  assert.equal(effective.config.heartbeat.enabled, false);
  assert.equal(effective.config.supervisor.idleTimeoutSeconds, 900);
  assert.equal(effective.config.retention.rawResponsesDays, 7);
  assert.equal(effective.config.retention.closedAssignmentsDays, 30);
  assert.equal(effective.config.retention.permanentArchiveDeletion, false);
  assert.equal(effective.config.execution.defaultInterruptionMode, "graceful");
  assert.equal(effective.config.execution.automaticForceEscalation, false);
  assert.deepEqual(effective.config.integrations.jira, {
    enabled: false,
    mode: "disabled",
    projectKeys: [],
    workflowProfiles: [],
    scrumAgent: {
      enabled: false,
      progressComments: true,
      progressIntervalMinutes: 30,
      timeTracking: "disabled",
      estimateUpdates: "propose",
    },
  });
  assert.match(effective.digest, /^sha256:[a-f0-9]{64}$/);
});

test("Jira custom workflow profiles load while inconsistent activation fails closed", async () => {
  const configured = await project({
    ".agent-workflow/config.json": {
      integrations: {
        jira: {
          enabled: true,
          mode: "observe",
          siteUrl: "https://example.atlassian.net",
          credentialReference: "jira.default",
          projectKeys: ["PAY"],
          workflowProfiles: [{
            id: "pay-story",
            projectKey: "PAY",
            issueTypes: ["Story"],
            mappings: {
              work_started: { targetStatus: "Development", authority: "automatic", fallback: "pending" },
            },
          }],
          scrumAgent: { enabled: true, progressComments: true, progressIntervalMinutes: 20, timeTracking: "observe", estimateUpdates: "propose" },
        },
      },
    },
  });
  const effective = await loadEffectiveConfiguration({ projectRoot: configured });
  assert.equal(effective.config.integrations.jira.mode, "observe");
  assert.equal(effective.config.integrations.jira.workflowProfiles[0]?.mappings.work_started?.targetStatus, "Development");

  const inconsistent = await project({
    ".agent-workflow/config.json": { integrations: { jira: { enabled: true, mode: "disabled" } } },
  });
  await assert.rejects(
    loadEffectiveConfiguration({ projectRoot: inconsistent }),
    (error) => errorCode(error) === "CONFIG_INVARIANT_VIOLATION",
  );
});

test("precedence is defaults, project, assignment, executive, provider restriction", async () => {
  const root = await project({
    ".agent-workflow/config.json": {
      schemaVersion: "1.0",
      heartbeat: { enabled: true, intervalSeconds: 120 },
      roles: { enabled: ["qa", "implementer"] },
      providers: { codex: { enabled: true }, claude: { enabled: true } },
    },
  });

  const effective = await loadEffectiveConfiguration({
    projectRoot: root,
    assignmentOverrides: {
      heartbeat: { intervalSeconds: 45 },
      roles: { enabled: ["reviewer"] },
    },
    executiveOverrides: { approvals: { initialPlan: "not_required" } },
    disabledProviders: ["codex"],
  });

  assert.deepEqual(effective.config.heartbeat, { enabled: true, intervalSeconds: 45 });
  assert.deepEqual(effective.config.roles.enabled, ["reviewer"]);
  assert.equal(effective.config.approvals.initialPlan, "not_required");
  assert.equal(effective.config.providers.claude?.enabled, true);
  assert.equal(effective.config.providers.codex?.enabled, false);
});

test("machine-local configuration cannot override governance", async () => {
  const root = await project({
    ".agent-workflow/local.json": { approvals: { initialPlan: "not_required" } },
  });

  await assert.rejects(
    loadEffectiveConfiguration({ projectRoot: root }),
    (error) => errorCode(error) === "CONFIG_LOCAL_GOVERNANCE_OVERRIDE",
  );
});

test("assignment and executive layers are constrained by authority metadata", async () => {
  const root = await project();

  await assert.rejects(
    loadEffectiveConfiguration({
      projectRoot: root,
      assignmentOverrides: { retention: { rawResponsesDays: 1 } },
    }),
    (error) => errorCode(error) === "CONFIG_OVERRIDE_NOT_ALLOWED",
  );
  await assert.rejects(
    loadEffectiveConfiguration({
      projectRoot: root,
      executiveOverrides: { heartbeat: { enabled: true } },
    }),
    (error) => errorCode(error) === "CONFIG_OVERRIDE_NOT_ALLOWED",
  );
  assert.ok(SETTING_AUTHORITIES.every((entry) => typeof entry.projectOverridable === "boolean"));
});

test("unknown keys and invariant violations use stable errors", async () => {
  const unknownRoot = await project({
    ".agent-workflow/config.json": { unknownPolicy: true },
  });
  await assert.rejects(
    loadEffectiveConfiguration({ projectRoot: unknownRoot }),
    (error) => errorCode(error) === "CONFIG_UNKNOWN_KEY",
  );

  const invariantRoot = await project({
    ".agent-workflow/config.json": {
      retention: { permanentArchiveDeletion: true },
    },
  });
  await assert.rejects(
    loadEffectiveConfiguration({ projectRoot: invariantRoot }),
    (error) => errorCode(error) === "CONFIG_INVARIANT_VIOLATION",
  );
});

test("digest is stable for semantically identical key and set ordering", async () => {
  const first = await project({
    ".agent-workflow/config.json": {
      roles: { enabled: ["qa", "implementer", "qa"] },
      providers: { codex: { enabled: true }, claude: { enabled: false } },
    },
  });
  const second = await project({
    ".agent-workflow/config.json": {
      providers: { claude: { enabled: false }, codex: { enabled: true } },
      roles: { enabled: ["implementer", "qa"] },
    },
  });

  assert.equal(
    (await loadEffectiveConfiguration({ projectRoot: first })).digest,
    (await loadEffectiveConfiguration({ projectRoot: second })).digest,
  );
});

test("extensions load deterministically and reject duplicate namespaces", async () => {
  const root = await project({
    ".agent-workflow/overrides/z.json": {
      namespace: "example.security",
      version: "1.0.0",
      config: { gate: "review" },
    },
    ".agent-workflow/overrides/a.json": {
      namespace: "example.delivery",
      version: "1.0.0",
      config: { target: "staging" },
    },
  });
  const effective = await loadEffectiveConfiguration({ projectRoot: root });
  assert.deepEqual(Object.keys(effective.extensions), ["example.delivery", "example.security"]);

  const duplicate = await project({
    ".agent-workflow/overrides/a.json": {
      namespace: "example.security", version: "1", config: {},
    },
    ".agent-workflow/overrides/b.json": {
      namespace: "example.security", version: "2", config: {},
    },
  });
  await assert.rejects(
    loadEffectiveConfiguration({ projectRoot: duplicate }),
    (error) => errorCode(error) === "CONFIG_EXTENSION_DUPLICATE",
  );
});

test("required project configuration reports absence", async () => {
  await assert.rejects(
    loadEffectiveConfiguration({ projectRoot: await project(), requireProjectConfig: true }),
    (error) => errorCode(error) === "CONFIG_FILE_NOT_FOUND",
  );
});
