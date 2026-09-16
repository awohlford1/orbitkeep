import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installConsumer } from "../../src/installer/index.ts";
import { LocalFileSiloCredentialProvider } from "../../src/silo/index.ts";
import { doctor } from "../../src/cli/diagnostics.ts";

async function installedProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-silo-credentials-"));
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, "package.json"), "{}\n"));
  await installConsumer(root); return root;
}

test("local credential provider creates an idempotent Ed25519 key and signs without exposing private material", async () => {
  const root = await installedProject(); const provider = new LocalFileSiloCredentialProvider(root, ".agent-state", () => new Date("2026-01-01T00:00:00.000Z"));
  const key = await provider.createKey("silo-dev-1"); const repeated = await provider.createKey("silo-dev-1");
  assert.deepEqual(repeated, key); assert.equal(key.algorithm, "ed25519"); assert.match(key.fingerprint, /^sha256:[a-f0-9]{64}$/);
  const payload = new TextEncoder().encode("registration request"); const signature = await provider.sign(key.keyId, payload);
  assert.equal(verify(null, payload, createPublicKey(key.publicKey), signature), true);
  const metadata = await readFile(path.join(root, ".agent-state", "registration", "keys.json"), "utf8");
  assert.doesNotMatch(metadata, /PRIVATE KEY/); assert.match(metadata, /local_file_degraded/);
  const privatePath = path.join(root, ".agent-state", ".runtime", "credentials", "silo-keys", "silo-dev-1.pem");
  assert.match(await readFile(privatePath, "utf8"), /PRIVATE KEY/);
  if (process.platform !== "win32") assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
  assert.deepEqual(await provider.assess(), { available: true, protection: "local_file_degraded", findings: ["Private signing material uses local file protection and is not a hardened credential boundary."] });
  const report = await doctor(root); assert.equal(report.silo.healthState, "degraded"); assert.equal(report.silo.credential.protection, "local_file_degraded");
});

test("key replacement retains bounded public lineage and prevents retirement of the active key", async () => {
  const root = await installedProject(); let tick = 0; const provider = new LocalFileSiloCredentialProvider(root, ".agent-state", () => new Date(1_700_000_000_000 + tick++ * 1_000));
  const oldKey = await provider.createKey("silo-old"); const currentKey = await provider.createKey("silo-current");
  assert.equal(oldKey.status, "active"); assert.equal(currentKey.status, "overlap");
  await assert.rejects(provider.retireKey("silo-old"), /SILO_KEY_ROTATION_PENDING/);
  const activated = await provider.activateKey("silo-current"); assert.equal(activated.status, "active");
  await provider.retireKey("silo-old");
  await assert.rejects(provider.sign("silo-old", new Uint8Array([1])), /SILO_KEY_PROVIDER_UNAVAILABLE/);
  await assert.rejects(provider.retireKey("silo-current"), /SILO_KEY_ROTATION_PENDING/);
  const metadata = JSON.parse(await readFile(path.join(root, ".agent-state", "registration", "keys.json"), "utf8")) as { public_keys: Array<{ key_id: string; status: string }> };
  assert.equal(metadata.public_keys.find((item) => item.key_id === "silo-old")?.status, "retired");
});

test("credential assessment becomes unavailable when active private material is missing", async () => {
  const root = await installedProject(); const provider = new LocalFileSiloCredentialProvider(root); await provider.createKey("silo-dev");
  await import("node:fs/promises").then(({ rm }) => rm(path.join(root, ".agent-state", ".runtime", "credentials", "silo-keys", "silo-dev.pem")));
  const assessment = await provider.assess(); assert.equal(assessment.available, false); assert.equal(assessment.protection, "unavailable");
  const report = await doctor(root); assert.equal(report.silo.healthState, "blocked"); assert.equal(report.activation, "blocked");
});
