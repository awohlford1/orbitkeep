import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { doctor } from "../../src/cli/diagnostics.ts";
import { applyRepair, deriveSiloConsumer, installConsumer, planRepair } from "../../src/installer/index.ts";
import { ensureSiloIdentity, inspectSiloIdentity } from "../../src/silo/index.ts";
import { initializeStateRoot } from "../../src/storage/index.ts";

async function project(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await writeFile(path.join(root, "package.json"), "{}\n");
  return root;
}

test("Silo initialization is deterministic, validated, and idempotent", async () => {
  const root = await project("orbitkeep-silo-");
  const { stateRoot } = await initializeStateRoot(root);
  await mkdir(path.join(root, ".agent-workflow"), { recursive: true });
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const first = await ensureSiloIdentity(root, ".agent-state", { now: () => new Date("2026-01-01T00:00:00.000Z"), id: () => ids.shift()!, originHint: null });
  assert.equal(first.descriptor.silo_id, "silo-11111111-1111-4111-8111-111111111111");
  assert.equal(first.instance.silo_instance_id, "sinst-22222222-2222-4222-8222-222222222222");
  assert.equal(first.descriptorCreated, true); assert.equal(first.instanceCreated, true);
  const second = await ensureSiloIdentity(root, ".agent-state", { id: () => { throw new Error("must not regenerate"); }, originHint: null });
  assert.equal(second.descriptor.silo_id, first.descriptor.silo_id);
  assert.equal(second.instance.silo_instance_id, first.instance.silo_instance_id);
  assert.equal(second.descriptorCreated, false); assert.equal(second.instanceCreated, false);
  assert.equal((await inspectSiloIdentity(root)).valid, true);
  assert.match(await readFile(path.join(stateRoot, ".runtime", "silo-instance.json"), "utf8"), /workspace_fingerprint/);
});

test("concurrent initialization creates exactly one logical and local identity", async () => {
  const root = await project("orbitkeep-silo-concurrent-");
  await initializeStateRoot(root); await mkdir(path.join(root, ".agent-workflow"), { recursive: true });
  const results = await Promise.all(Array.from({ length: 12 }, () => ensureSiloIdentity(root, ".agent-state", { originHint: null })));
  assert.equal(new Set(results.map((item) => item.descriptor.silo_id)).size, 1);
  assert.equal(new Set(results.map((item) => item.instance.silo_instance_id)).size, 1);
  assert.equal(results.filter((item) => item.descriptorCreated).length, 1);
  assert.equal(results.filter((item) => item.instanceCreated).length, 1);
});

test("installation records one idempotent identity event pair and reports Silo status", async () => {
  const root = await project("orbitkeep-silo-install-");
  const first = await installConsumer(root); const second = await installConsumer(root);
  assert.equal(second.siloIdentity.descriptor.silo_id, first.siloIdentity.descriptor.silo_id);
  assert.equal(second.siloIdentity.instance.silo_instance_id, first.siloIdentity.instance.silo_instance_id);
  const eventFiles = await readdir(path.join(root, ".agent-state", "events"));
  const events = (await Promise.all(eventFiles.map(async (name) => (await readFile(path.join(root, ".agent-state", "events", name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event_type: string })))).flat();
  assert.equal(events.filter((item) => item.event_type === "silo.identity_created").length, 1);
  assert.equal(events.filter((item) => item.event_type === "silo.instance_created").length, 1);
  const report = await doctor(root);
  assert.equal(report.silo.identity.valid, true);
  assert.equal(report.silo.identity.siloId, first.siloIdentity.descriptor.silo_id);
  assert.equal(report.silo.administrativeState, "unregistered");
  assert.equal(report.silo.connectivityState, "offline");
  assert.equal(report.silo.healthState, "healthy");
});

test("repair regenerates a missing local instance but never replaces a lost committed descriptor", async () => {
  const instanceRoot = await project("orbitkeep-silo-instance-repair-"); await installConsumer(instanceRoot);
  await rm(path.join(instanceRoot, ".agent-state", ".runtime", "silo-instance.json"));
  const instancePlan = await planRepair(instanceRoot);
  assert.ok(instancePlan.actions.some((item) => item.path.endsWith("silo-instance.json") && item.action === "reconcile"));
  await applyRepair(instanceRoot); assert.equal((await inspectSiloIdentity(instanceRoot)).valid, true);

  const descriptorRoot = await project("orbitkeep-silo-descriptor-loss-"); await installConsumer(descriptorRoot);
  await rm(path.join(descriptorRoot, ".agent-workflow", "silo.json"));
  const descriptorPlan = await planRepair(descriptorRoot);
  assert.equal(descriptorPlan.safe, false);
  assert.ok(descriptorPlan.actions.some((item) => item.path === ".agent-workflow/silo.json" && item.action === "manual"));
  await applyRepair(descriptorRoot);
  await assert.rejects(readFile(path.join(descriptorRoot, ".agent-workflow", "silo.json")), /ENOENT/);
});

test("malformed and mismatched identity records fail without silent replacement", async () => {
  const malformed = await project("orbitkeep-silo-malformed-"); await installConsumer(malformed);
  const descriptorPath = path.join(malformed, ".agent-workflow", "silo.json"); await writeFile(descriptorPath, "{broken");
  await assert.rejects(ensureSiloIdentity(malformed), /SILO_IDENTITY_INVALID/);
  assert.equal(await readFile(descriptorPath, "utf8"), "{broken");

  const mismatch = await project("orbitkeep-silo-mismatch-"); await installConsumer(mismatch);
  const instancePath = path.join(mismatch, ".agent-state", ".runtime", "silo-instance.json");
  const instance = JSON.parse(await readFile(instancePath, "utf8")) as { silo_id: string }; instance.silo_id = "silo-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; await writeFile(instancePath, `${JSON.stringify(instance, null, 2)}\n`);
  const inspection = await inspectSiloIdentity(mismatch);
  assert.equal(inspection.valid, false);
  assert.ok(inspection.errors.some((item) => item.code === "SILO_INSTANCE_MISMATCH"));
});

test("explicit derivation transaction replaces both identities and records lineage", async () => {
  const root = await project("orbitkeep-silo-derive-"); const installed = await installConsumer(root);
  const result = await deriveSiloConsumer(root);
  assert.notEqual(result.descriptor.silo_id, installed.siloIdentity.descriptor.silo_id);
  assert.notEqual(result.instance.silo_instance_id, installed.siloIdentity.instance.silo_instance_id);
  assert.equal(result.previousSiloId, installed.siloIdentity.descriptor.silo_id);
  assert.equal(result.descriptor.derived_from_silo_id, installed.siloIdentity.descriptor.silo_id);
  assert.equal(result.instance.silo_id, result.descriptor.silo_id);
  const events = (await Promise.all((await readdir(path.join(root, ".agent-state", "events"))).map(async (name) => (await readFile(path.join(root, ".agent-state", "events", name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event_type: string; silo_id?: string })))).flat();
  assert.equal(events.filter((item) => item.event_type === "silo.identity_derived" && item.silo_id === result.descriptor.silo_id).length, 1);
  assert.equal(events.filter((item) => item.event_type === "silo.instance_created" && item.silo_id === result.descriptor.silo_id).length, 1);
});

test("derivation is blocked by open Missions and registration", async () => {
  const activeRoot = await project("orbitkeep-silo-derive-active-"); await installConsumer(activeRoot);
  const assignmentRoot = path.join(activeRoot, ".agent-state", "assignments", "asn-active", "assignment"); await mkdir(assignmentRoot, { recursive: true });
  await writeFile(path.join(assignmentRoot, "asn-active.json"), JSON.stringify({ lifecycle: "running", executions: [] }));
  await assert.rejects(deriveSiloConsumer(activeRoot), /SILO_DERIVATION_BLOCKED/);

  const registeredRoot = await project("orbitkeep-silo-derive-registered-"); await installConsumer(registeredRoot);
  await writeFile(path.join(registeredRoot, ".agent-state", "registration", "receipt.json"), "{}\n");
  await assert.rejects(deriveSiloConsumer(registeredRoot), /SILO_DERIVATION_BLOCKED/);
});

test("lost committed Silo descriptor blocks doctor rather than appearing merely degraded", async () => {
  const root = await project("orbitkeep-silo-doctor-loss-"); await installConsumer(root);
  await rm(path.join(root, ".agent-workflow", "silo.json"));
  const report = await doctor(root);
  assert.equal(report.activation, "blocked");
  assert.equal(report.silo.healthState, "blocked");
  assert.ok(report.errors.some((item) => item.includes("Manual repair is required")));
});
