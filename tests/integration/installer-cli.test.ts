import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRepair, installConsumer, planRepair, preflightInstall } from "../../src/installer/index.ts";
import { doctor, validateInstallation } from "../../src/cli/diagnostics.ts";

test("consumer initialization is idempotent and preserves existing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await (await import("node:fs/promises")).mkdir(path.join(root, ".claude"));
  await writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing-hook" }] }] } }));
  await writeFile(path.join(root, "AGENTS.md"), "# Existing instructions\n\nKeep this text.\n");
  const first = await installConsumer(root);
  const configBefore = await readFile(path.join(root, ".agent-workflow", "config.json"), "utf8");
  const second = await installConsumer(root);
  assert.ok(first.created.length > 0);
  assert.ok(second.preserved.some((item) => item.endsWith("config.json")));
  assert.equal(await readFile(path.join(root, ".agent-workflow", "config.json"), "utf8"), configBefore);
  assert.equal((await readFile(path.join(root, ".gitignore"), "utf8")).match(/^\.agent-state\/$/gm)?.length, 1);
  const claude = await readFile(path.join(root, ".claude", "settings.json"), "utf8");
  assert.match(claude, /existing-hook/);
  assert.match(claude, /provider claude hook/);
  assert.match(claude, /provider claude hook --json/);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /Keep this text[\s\S]*Orbitkeep CLI Integration/);
  assert.match(await readFile(path.join(root, "CLAUDE.md"), "utf8"), /Orbitkeep Flight Director Integration[\s\S]*must not ask the Executive/);
  const report = await doctor(root);
  assert.equal(report.healthy, true);
  assert.deepEqual(report.integrations, { claude: true, codex: true });
  assert.equal(report.capabilities.hooks.claude.PreToolUse.level, "enforced");
  assert.match(report.capabilities.hooks.claude.PreToolUse.reason, /connected to workflow authorization/);
  assert.equal(report.capabilities.controls.brokered_raw_response_capture.level, "enforced");
});

test("validation detects missing contracts and generated role drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-drift-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  await writeFile(path.join(root, ".claude", "agents", "implementation.md"), "drifted\n");
  await rm(path.join(root, ".agent-workflow", "contracts", "MANAGER.md"));
  const report = await validateInstallation(root);
  assert.equal(report.valid, false);
  assert.ok(report.contracts.missing.includes("MANAGER.md"));
  assert.ok(report.roles.drift.includes(".claude/agents/implementation.md"));
});

test("empty and partial repositories initialize to an active installation", async () => {
  for (const partial of [false, true]) {
    const root = await mkdtemp(path.join(tmpdir(), "aw-install-shape-"));
    await writeFile(path.join(root, "package.json"), "{}\n");
    if (partial) { await mkdir(path.join(root, ".agent-workflow")); await writeFile(path.join(root, ".agent-workflow", "config.json"), "{\"schemaVersion\":\"1.0\"}\n"); }
    await installConsumer(root);
    assert.equal((await doctor(root)).activation, partial ? "active_limited" : "active");
  }
});

test("customized shared files are preserved inside a successful install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-custom-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(root, "AGENTS.md"), "# Project-owned rules\n");
  await installConsumer(root);
  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /Project-owned rules/);
  assert.match(agents, /agent-workflow:codex-manager:start/);
});

test("malformed setup fails preflight without creating a partial installation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-malformed-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await mkdir(path.join(root, ".claude"));
  await writeFile(path.join(root, ".claude", "settings.json"), "{broken");
  assert.equal((await preflightInstall(root)).status, "repair_required");
  await assert.rejects(installConsumer(root), /INSTALL_REPAIR_REQUIRED/);
  await assert.rejects(access(path.join(root, ".agent-workflow", "config.json")));
});

test("legacy setup is detected but left unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-legacy-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  const legacy = path.join(root, "docs", "agent-operations", "operating-contracts");
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "MANAGER.md"), "legacy\n");
  const result = await installConsumer(root);
  assert.equal(result.legacyDetected, true);
  assert.equal(await readFile(path.join(legacy, "MANAGER.md"), "utf8"), "legacy\n");
});

test("repair planning is read-only and apply backs up then restores managed drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-repair-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const manager = path.join(root, ".agent-workflow", "contracts", "MANAGER.md");
  const canonical = await readFile(manager, "utf8");
  await writeFile(manager, "drifted\n");
  const planned = await planRepair(root);
  assert.equal(planned.safe, true);
  assert.ok(planned.actions.some((action) => action.path.endsWith("contracts/MANAGER.md")));
  assert.equal(await readFile(manager, "utf8"), "drifted\n");
  const applied = await applyRepair(root);
  assert.equal(await readFile(manager, "utf8"), canonical);
  assert.ok(applied.backupDirectory);
  assert.equal(await readFile(path.join(applied.backupDirectory!, ".agent-workflow", "contracts", "MANAGER.md"), "utf8"), "drifted\n");
});

test("unsupported requested provider mode blocks activation without silent downgrade", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-mode-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const configPath = path.join(root, ".agent-workflow", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { providers: { codex: { requiredMode: string } } };
  config.providers.codex.requiredMode = "enforced";
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const report = await doctor(root);
  assert.equal(report.activation, "blocked");
  assert.equal(report.providerActivation.codex?.status, "unsupported");
});

test("repair reconciles a missing required provider integration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-provider-repair-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  await rm(path.join(root, ".claude", "settings.json"));
  const planned = await planRepair(root);
  assert.ok(planned.actions.some((action) => action.path === ".claude/settings.json" && action.action === "reconcile"));
  await applyRepair(root);
  assert.equal((await doctor(root)).providerActivation.claude?.status, "active");
});

test("repair detects and completes a partially installed Claude hook set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-partial-hooks-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const settingsPath = path.join(root, ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { hooks: Record<string, unknown> };
  delete settings.hooks.PreToolUse;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const planned = await planRepair(root);
  assert.ok(planned.actions.some((action) => action.path === ".claude/settings.json" && action.action === "reconcile"));
  await applyRepair(root);
  assert.equal((await doctor(root)).providerActivation.claude?.status, "active");
});

test("repair detects, backs up, and restores drift inside a managed instruction block", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-block-drift-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(root, "AGENTS.md"), "# Project rules\n\nKeep me.\n");
  await installConsumer(root);
  const agentsPath = path.join(root, "AGENTS.md");
  const canonical = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, canonical.replace("Use the pinned Orbitkeep CLI", "Use an unpinned workflow CLI"));
  const planned = await planRepair(root);
  assert.ok(planned.actions.some((action) => action.path === "AGENTS.md" && action.action === "reconcile"));
  const applied = await applyRepair(root);
  const repaired = await readFile(agentsPath, "utf8");
  assert.match(repaired, /# Project rules[\s\S]*Keep me/);
  assert.match(repaired, /Use the pinned Orbitkeep CLI/);
  assert.ok(applied.backupDirectory);
  assert.match(await readFile(path.join(applied.backupDirectory!, "AGENTS.md"), "utf8"), /unpinned workflow CLI/);
});
