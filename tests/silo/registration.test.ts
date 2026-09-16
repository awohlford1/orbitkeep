import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installConsumer } from "../../src/installer/index.ts";
import { InMemorySiloRegistrationClient, LocalFileSiloCredentialProvider, SiloRegistrationService, type RegistrationRequest, type SiloRegistrationClient } from "../../src/silo/index.ts";
import { doctor } from "../../src/cli/diagnostics.ts";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-silo-registration-")); await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, "package.json"), "{}\n")); await installConsumer(root);
  const now = () => new Date("2026-01-01T00:00:00.000Z"); const client = new InMemorySiloRegistrationClient({ now }); const credentials = new LocalFileSiloCredentialProvider(root, ".agent-state", now);
  const service = new SiloRegistrationService({ projectRoot: root, credentials, client, trustedAuthorityKeys: { [client.authorityKeyId]: client.authorityPublicKey }, now });
  return { root, now, client, credentials, service };
}

test("signed registration persists intent first and atomically accepts a trusted receipt", async () => {
  const { root, service } = await setup();
  const response = await service.register({ keyId: "silo-registration", keepId: "keep-primary", colonyId: "col-platform", capabilities: ["provider:codex", "provider:claude", "provider:codex"], charter: { schemaVersion: "1.0", charterId: "charter-primary" }, idempotencyId: "idem-registration-1" });
  assert.equal(response.status, "granted");
  const request = JSON.parse(await readFile(path.join(root, ".agent-state", "registration", "request.json"), "utf8")) as RegistrationRequest;
  const receipt = JSON.parse(await readFile(path.join(root, ".agent-state", "registration", "receipt.json"), "utf8")) as { silo_id: string; keep_id: string; colony_id: string };
  assert.equal(receipt.silo_id, request.silo_id); assert.equal(receipt.keep_id, "keep-primary"); assert.equal(receipt.colony_id, "col-platform");
  const eventLines = (await Promise.all((await readdir(path.join(root, ".agent-state", "events"))).map(async (name) => (await readFile(path.join(root, ".agent-state", "events", name), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event_type: string; sequence: number })))).flat().sort((a, b) => a.sequence - b.sequence);
  assert.ok(eventLines.findIndex((item) => item.event_type === "silo.registration_requested") < eventLines.findIndex((item) => item.event_type === "silo.registration_granted"));
  await assert.rejects(service.register({ keyId: "another", keepId: "keep-primary", charter: { schemaVersion: "1.0" } }), /SILO_ALREADY_REGISTERED/);
});

test("in-memory registration client is idempotent and rejects conflicting reuse", async () => {
  const { root, client, credentials } = await setup(); const key = await credentials.createKey("silo-idempotency");
  const identity = JSON.parse(await readFile(path.join(root, ".agent-workflow", "silo.json"), "utf8")) as { silo_id: string }; const instance = JSON.parse(await readFile(path.join(root, ".agent-state", ".runtime", "silo-instance.json"), "utf8")) as { silo_instance_id: string };
  const base = { schema_version: "1.0" as const, request_id: "sreq-one", idempotency_id: "idem-one", silo_id: identity.silo_id, silo_instance_id: instance.silo_instance_id, public_key: key.publicKey, key_id: key.keyId, keep_id: "keep-one", capability_digest: `sha256:${"0".repeat(64)}`, charter: { schema_version: "1.0" }, issued_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T00:05:00.000Z", nonce: "nonce-one" };
  const { canonicalJson } = await import("../../src/config/index.ts"); const request = { ...base, signature: Buffer.from(await credentials.sign(key.keyId, new TextEncoder().encode(canonicalJson(base)))).toString("base64") };
  assert.deepEqual(await client.register(request), await client.register(request));
  await assert.rejects(client.register({ ...request, request_id: "sreq-two" }), /idempotency key was reused/);
});

test("an invalid Keep receipt is quarantined and never becomes registration state", async () => {
  const { root, now, client, credentials } = await setup();
  const invalidClient: SiloRegistrationClient = {
    register: async (request) => { const response = await client.register(request); return response.status === "granted" ? { status: "granted", receipt: { ...response.receipt, signature: "invalid" } } : response; },
    rotateKey: (request) => client.rotateKey(request), retire: (request) => client.retire(request), disconnect: (request) => client.disconnect(request),
  };
  const service = new SiloRegistrationService({ projectRoot: root, credentials, client: invalidClient, trustedAuthorityKeys: { [client.authorityKeyId]: client.authorityPublicKey }, now });
  await assert.rejects(service.register({ keyId: "silo-invalid", keepId: "keep-one", charter: { schemaVersion: "1.0" } }), /SILO_REGISTRATION_INVALID/);
  await assert.rejects(readFile(path.join(root, ".agent-state", "registration", "receipt.json")), /ENOENT/);
  const quarantined = await readdir(path.join(root, ".agent-state", "quarantine")); assert.equal(quarantined.length, 1);
  const content = await readFile(path.join(root, ".agent-state", "quarantine", quarantined[0]!), "utf8"); assert.match(content, /SILO_REGISTRATION_INVALID/); assert.match(content, /"signature": "invalid"/);
});

test("an unknown registration outcome creates a Silo-scoped pending action", async () => {
  const { root, now, credentials } = await setup();
  const unknownClient: SiloRegistrationClient = {
    register: async () => ({ status: "unknown", reason: "Keep acknowledgement timed out." }),
    rotateKey: async () => ({ status: "unknown" }), retire: async () => ({ status: "unknown" }), disconnect: async () => ({ status: "unknown" }),
  };
  const service = new SiloRegistrationService({ projectRoot: root, credentials, client: unknownClient, trustedAuthorityKeys: {}, now });
  const response = await service.register({ keyId: "silo-unknown", keepId: "keep-one", charter: { schemaVersion: "1.0" } }); assert.equal(response.status, "unknown");
  const pendingFiles = await readdir(path.join(root, ".agent-state", "pending")); assert.equal(pendingFiles.length, 1);
  const pending = JSON.parse(await readFile(path.join(root, ".agent-state", "pending", pendingFiles[0]!), "utf8")) as { assignment_id?: string; silo_id?: string; request_id?: string; observed_outcome: string };
  assert.equal(pending.assignment_id, undefined); assert.match(pending.silo_id ?? "", /^silo-/); assert.match(pending.request_id ?? "", /^sreq-/); assert.equal(pending.observed_outcome, "unknown");
  await assert.rejects(readFile(path.join(root, ".agent-state", "registration", "receipt.json")), /ENOENT/);
});

test("retrying the same registration reconciles a late concrete response", async () => {
  const { root, now, client, credentials } = await setup(); let attempts = 0;
  const delayedClient: SiloRegistrationClient = {
    register: async (request) => ++attempts === 1 ? { status: "unknown", reason: "acknowledgement lost" } : client.register(request),
    rotateKey: (request) => client.rotateKey(request), retire: (request) => client.retire(request), disconnect: (request) => client.disconnect(request),
  };
  const service = new SiloRegistrationService({ projectRoot: root, credentials, client: delayedClient, trustedAuthorityKeys: { [client.authorityKeyId]: client.authorityPublicKey }, now });
  const input = { keyId: "silo-late", keepId: "keep-one", charter: { schemaVersion: "1.0" }, idempotencyId: "idem-late" };
  assert.equal((await service.register(input)).status, "unknown"); assert.equal((await readdir(path.join(root, ".agent-state", "pending"))).length, 1);
  assert.equal((await service.register(input)).status, "granted"); assert.equal((await readdir(path.join(root, ".agent-state", "pending"))).length, 0);
  const validations = await readdir(path.join(root, ".agent-state", "validations")); assert.ok(validations.some((name) => name.startsWith("reconciliation-act-registration-")));
});

test("doctor revalidates configured registration trust after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-silo-registration-doctor-")); const { writeFile } = await import("node:fs/promises"); await writeFile(path.join(root, "package.json"), "{}\n"); await installConsumer(root);
  const instant = new Date(); const now = () => instant; const client = new InMemorySiloRegistrationClient({ now }); const credentials = new LocalFileSiloCredentialProvider(root, ".agent-state", now);
  const service = new SiloRegistrationService({ projectRoot: root, credentials, client, trustedAuthorityKeys: { [client.authorityKeyId]: client.authorityPublicKey }, now });
  assert.equal((await service.register({ keyId: "silo-doctor", keepId: "keep-one", charter: { schemaVersion: "1.0" } })).status, "granted");
  const configPath = path.join(root, ".agent-workflow", "config.json"); const config = JSON.parse(await readFile(configPath, "utf8")) as { silo: { credentialProvider: string; registration: { required: boolean; trustedAuthorityKeys: Record<string, string> } } };
  config.silo.credentialProvider = "local_file_degraded"; config.silo.registration.trustedAuthorityKeys[client.authorityKeyId] = client.authorityPublicKey; await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const report = await doctor(root); assert.equal(report.silo.administrativeState, "registered"); assert.equal(report.silo.membership!.keepId, "keep-one"); assert.equal(report.silo.healthState, "degraded");
  config.silo.registration.trustedAuthorityKeys = {}; await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const untrusted = await doctor(root); assert.equal(untrusted.silo.administrativeState, "unregistered"); assert.equal(untrusted.silo.healthState, "blocked"); assert.ok(untrusted.errors.some((item) => item.includes("No trusted authority key")));
});
