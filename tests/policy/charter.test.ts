import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import defaults from "../../defaults/config.json" with { type: "json" };
import { canonicalJson } from "../../src/config/index.ts";
import type { FrameworkConfiguration } from "../../src/contracts/configuration.ts";
import { acceptCentralCharter, charterFromConfiguration, charterSchema, evaluateCharters, validateCharter, verifySignedCharter, type CharterDocument } from "../../src/policy/index.ts";
import { validateJsonSchema } from "../../src/validation/schema/index.ts";
import { MemoryWorkflowRepository, WorkflowCommandService } from "../../src/commands/index.ts";

const issuedAt = "2026-09-15T00:00:00.000Z";
const local: CharterDocument = { schemaVersion: "1.0", charterId: "chr-local", revision: 2, issuedAt, rules: {
  providers: { allowed: ["codex", "claude"] }, crew: { allowedRoles: ["implementation", "security"] },
  models: { allowedByRole: { implementation: ["codex:gpt-5"] } }, filesystem: { read: ["**"], write: ["src/**"] },
  network: { allowedHosts: ["api.example.com"] }, secrets: { allowedReferences: ["secret:build"] }, resources: { maxTotalTokens: 1000, maxConcurrentOperations: 2 },
  gates: { required: ["tests"] }, clearances: { requiredActions: ["deploy"] }, retention: { maxRawResponsesDays: 7 }, redaction: { required: true },
} };

test("central and Local Charter are intersected and local policy cannot expand authority", () => {
  assert.equal(validateJsonSchema("charter", "1.0", charterSchema, local).valid, true);
  const central: CharterDocument = { schemaVersion: "1.0", charterId: "chr-central", revision: 4, issuedAt, rules: { providers: { allowed: ["codex"] }, network: { allowedHosts: ["*.example.com"] }, resources: { maxTotalTokens: 800 } } };
  const allowed = evaluateCharters({ central, local }, { action: "run", provider: "codex", model: "gpt-5", role: "implementation", writePaths: ["src/app.ts"], networkHosts: ["api.example.com"], secretReferences: ["secret:build"], budget: { totalTokens: 700 }, concurrentOperations: 2, satisfiedGates: ["tests"], rawResponsesDays: 7, redactionEnabled: true });
  assert.equal(allowed.allowed, true);
  const denied = evaluateCharters({ central, local }, { action: "run", provider: "claude", role: "implementation", writePaths: ["docs/readme.md"], networkHosts: ["evil.test"], budget: { totalTokens: 900 }, satisfiedGates: [] });
  assert.equal(denied.allowed, false);
  assert.ok(denied.violations.some((item) => item.includes("chr-central:provider_not_allowed")));
  assert.ok(denied.violations.some((item) => item.includes("chr-local:filesystem_write_not_allowed")));
  assert.ok(denied.violations.some((item) => item.includes("chr-central:resource_limit_exceeded")));
});

test("gates, Clearances, retention, and redaction fail closed when required", () => {
  const decision = evaluateCharters({ local }, { action: "deploy", provider: "codex", role: "implementation", satisfiedGates: [], clearanceGranted: false, rawResponsesDays: 30, redactionEnabled: false });
  assert.deepEqual(decision.violations.sort(), ["chr-local:clearance_required:deploy", "chr-local:gate_required:tests", "chr-local:redaction_required", "chr-local:retention_exceeded:rawResponsesDays"].sort());
});

test("signed central Charters reject untrusted, tampered, and expired policy", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const central: CharterDocument = { schemaVersion: "1.0", charterId: "chr-central", revision: 1, issuedAt, expiresAt: "2026-09-16T00:00:00.000Z", rules: { providers: { allowed: ["codex"] } } };
  const signature = sign(null, Buffer.from(canonicalJson(central)), privateKey).toString("base64");
  const trusted = { "key-1": publicKey.export({ type: "spki", format: "pem" }).toString() };
  assert.deepEqual(verifySignedCharter({ keyId: "key-1", charter: central, signature }, trusted, new Date(issuedAt)), central);
  assert.throws(() => verifySignedCharter({ keyId: "missing", charter: central, signature }, trusted), /CHARTER_UNTRUSTED_KEY/);
  assert.throws(() => verifySignedCharter({ keyId: "key-1", charter: { ...central, revision: 2 }, signature }, trusted), /CHARTER_SIGNATURE_INVALID/);
  assert.throws(() => verifySignedCharter({ keyId: "key-1", charter: central, signature }, trusted, new Date("2026-09-17T00:00:00.000Z")), /CHARTER_EXPIRED/);
  assert.throws(() => verifySignedCharter({ keyId: "key-1", charter: central, signature }, trusted, new Date("2026-09-14T00:00:00.000Z")), /CHARTER_NOT_YET_VALID/);
});

test("central Charter acceptance is monotonic and identical replay is idempotent", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trusted = { key: publicKey.export({ type: "spki", format: "pem" }).toString() };
  const signed = (charter: CharterDocument) => ({ keyId: "key", charter, signature: sign(null, Buffer.from(canonicalJson(charter)), privateKey).toString("base64") });
  const first: CharterDocument = { schemaVersion: "1.0", charterId: "chr-keep", revision: 2, issuedAt, rules: { providers: { allowed: ["codex"] } } };
  assert.deepEqual(acceptCentralCharter({ signed: signed(first), trustedKeys: trusted, now: new Date(issuedAt) }), first);
  assert.deepEqual(acceptCentralCharter({ signed: signed(first), trustedKeys: trusted, current: first, now: new Date(issuedAt) }), first);
  const older = { ...first, revision: 1 };
  assert.throws(() => acceptCentralCharter({ signed: signed(older), trustedKeys: trusted, current: first, now: new Date(issuedAt) }), /CHARTER_REVISION_ROLLBACK/);
  const conflict = { ...first, rules: { providers: { allowed: ["claude"] } } };
  assert.throws(() => acceptCentralCharter({ signed: signed(conflict), trustedKeys: trusted, current: first, now: new Date(issuedAt) }), /CHARTER_REVISION_CONFLICT/);
});

test("Charter validation rejects unknown fields and configuration adapter preserves deny semantics", () => {
  assert.throws(() => validateCharter({ ...local, surprise: true }), /unknown root properties/);
  const config = structuredClone(defaults) as FrameworkConfiguration;
  config.providers.claude = { enabled: false };
  const adapted = charterFromConfiguration(config, issuedAt);
  assert.equal(evaluateCharters({ local: adapted }, { action: "run", provider: "claude", role: "implementation", redactionEnabled: true }).allowed, false);
  assert.equal(evaluateCharters({ local: adapted }, { action: "run", provider: "codex", role: "implementation", redactionEnabled: true }).allowed, true);
});

test("managed dispatch enforces a verified central Charter before creating a Run", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const central: CharterDocument = { schemaVersion: "1.0", charterId: "chr-central-dispatch", revision: 1, issuedAt, rules: { providers: { allowed: ["claude"] } } };
  const signed = { keyId: "keep-key", charter: central, signature: sign(null, Buffer.from(canonicalJson(central)), privateKey).toString("base64") };
  const repository = new MemoryWorkflowRepository();
  const adapter = { async requestStop() { return { confirmed: true }; }, async createTransferPackage() { return { packageId: "pkg-1", valid: true }; }, async transferOwnership() { return { accepted: true }; } };
  const service = new WorkflowCommandService(repository, defaults as FrameworkConfiguration, adapter, { centralCharter: signed, trustedCharterKeys: { "keep-key": publicKey.export({ type: "spki", format: "pem" }).toString() } });
  const base = { actor: { actorId: "executive-1", actorType: "executive" as const }, managerInstanceId: "mgr-charter" };
  const started = await service.start({ objective: "Charter dispatch", approach: ["test"], acceptanceCriteria: ["denied"], waiveApproval: true }, base);
  const context = { ...base, ownershipToken: started.assignment.ownershipLease!.token };
  const task = await service.createTask(started.assignment.assignmentId, ["src/a.ts"], context);
  await service.transitionTask(started.assignment.assignmentId, task.taskId, "ready", context);
  await assert.rejects(service.beginManagedExecution(started.assignment.assignmentId, task.taskId, "implementation", { objective: "Implement", scope: ["src/a.ts"], exclusions: [], acceptance_criteria: [{ id: "AC-1", text: "passes" }], permissions: ["edit"], constraints: [], expected_outputs: ["code"], requested_model: { provider: "codex", model: "gpt-5" } }, context), /CHARTER_DENIED.*provider_not_allowed/);
  assert.equal((await repository.get(started.assignment.assignmentId))?.executions.length, 0);
});
