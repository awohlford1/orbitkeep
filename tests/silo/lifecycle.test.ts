import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installConsumer } from "../../src/installer/index.ts";
import { SiloLifecycleRepository } from "../../src/silo/index.ts";
import { doctor } from "../../src/cli/diagnostics.ts";

async function setup() { const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-silo-lifecycle-")); await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, "package.json"), "{}\n")); await installConsumer(root); return { root, lifecycle: new SiloLifecycleRepository(root, ".agent-state", () => new Date("2026-01-01T00:00:00.000Z")) }; }

test("capability observations are deterministic, canonical, and identity-bound", async () => {
  const { root, lifecycle } = await setup(); const first = await lifecycle.observeCapabilities(["provider:codex", "provider:claude", "provider:codex"]); const second = await lifecycle.observeCapabilities(["provider:claude", "provider:codex"]);
  assert.deepEqual(first.capabilities, ["provider:claude", "provider:codex"]); assert.equal(second.digest, first.digest);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, ".agent-state", "registration", "capabilities.json"), "utf8")), second);
});

test("connectivity follows explicit transitions and never infers acknowledgement", async () => {
  const { root, lifecycle } = await setup();
  await assert.rejects(lifecycle.observeConnection("connected"), /offline -> connected/);
  await lifecycle.observeConnection("connecting"); await lifecycle.observeConnection("connected", { sessionId: "relay-session-1" }); await lifecycle.observeConnection("disconnected", { reason: "acknowledged close" }); await lifecycle.observeConnection("offline");
  const stored = JSON.parse(await readFile(path.join(root, ".agent-state", "registration", "connection.json"), "utf8")) as { state: string }; assert.equal(stored.state, "offline");
});

test("health is derived from evidence strength and cannot be supplied by the caller", async () => {
  const { lifecycle } = await setup();
  assert.equal((await lifecycle.assessHealth([{ code: "hooks", level: "enforced", message: "Hooks are active." }])).state, "healthy");
  assert.equal((await lifecycle.assessHealth([{ code: "policy", level: "instructed", message: "Policy depends on instructions." }])).state, "degraded");
  assert.equal((await lifecycle.assessHealth([{ code: "sandbox", level: "unsupported", message: "Required sandbox is unavailable." }])).state, "blocked");
});

test("Silo status projects validated observations and does not overstate stale connectivity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-silo-lifecycle-status-")); await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, "package.json"), "{}\n")); await installConsumer(root);
  const clock = new Date(); const lifecycle = new SiloLifecycleRepository(root, ".agent-state", () => clock);
  const capabilities = await lifecycle.observeCapabilities(["provider:codex"]); await lifecycle.observeConnection("connecting"); await lifecycle.observeConnection("connected", { livenessSeconds: 60 }); await lifecycle.assessHealth([{ code: "provider", level: "enforced", message: "Provider is enforced." }]);
  const connected = await doctor(root); assert.equal(connected.silo.connectivityState, "connected"); assert.equal(connected.silo.capabilities!.digest, capabilities.digest); assert.equal(connected.silo.latestHealthAssessment!.state, "healthy");
  const recordPath = path.join(root, ".agent-state", "registration", "connection.json"); const observation = JSON.parse(await readFile(recordPath, "utf8")) as { valid_until: string }; observation.valid_until = "2020-01-01T00:00:00.000Z"; await import("node:fs/promises").then(({ writeFile }) => writeFile(recordPath, `${JSON.stringify(observation, null, 2)}\n`));
  const stale = await doctor(root); assert.equal(stale.silo.connectivityState, "disconnected"); assert.ok(stale.warnings.some((item) => item.includes("liveness window")));
});
