import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.match(await readFile(path.join(root, "CLAUDE.md"), "utf8"), /Orbitkeep Flight Director Integration[\s\S]*ask the Executive for internal framework values/);
  assert.match(await readFile(path.join(root, "CLAUDE.md"), "utf8"), /starts provider work headlessly[\s\S]*structured Flight Plan/);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /starts provider work headlessly[\s\S]*grant Executive approval/);
  const report = await doctor(root);
  assert.equal(report.healthy, true);
  assert.deepEqual(report.integrations, { claude: true, codex: true });
  assert.equal(report.capabilities.hooks.claude.PreToolUse.level, "enforced");
  assert.match(report.capabilities.hooks.claude.PreToolUse.reason, /connected to workflow authorization/);
  assert.equal(report.capabilities.controls.brokered_raw_response_capture.level, "enforced");
});

test("managed provider-reference blocks update while surrounding project instructions remain untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-reference-update-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(root, "CLAUDE.md"), "# Project instructions\n\nKeep this text.\n");
  await installConsumer(root);
  const reference = await readFile(path.join(root, "CLAUDE.md"), "utf8");
  const outdated = reference.replace("In planning mode, perform read-only discovery and return the requested structured Flight Plan. ", "");
  await writeFile(path.join(root, "CLAUDE.md"), outdated);
  const result = await installConsumer(root);
  const updated = await readFile(path.join(root, "CLAUDE.md"), "utf8");
  assert.match(updated, /# Project instructions[\s\S]*Keep this text/);
  assert.match(updated, /planning mode[\s\S]*structured Flight Plan/);
  assert.ok(result.created.some((item) => item.endsWith("CLAUDE.md#agent-workflow-reference-updated")));
});

test("setup advances unchanged framework manager assets recorded by the prior manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-framework-asset-update-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const relative = ".agent-workflow/contracts/MANAGER.md";
  const filename = path.join(root, relative);
  const current = await readFile(filename, "utf8");
  const prior = current.replace("# Flight Director Contract", "# Prior Flight Director Contract");
  await writeFile(filename, prior);
  const manifestPath = path.join(root, ".agent-workflow", "install-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { managed: Record<string, string> };
  manifest.managed[relative] = `sha256:${createHash("sha256").update(prior).digest("hex")}`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = await installConsumer(root);
  assert.match(await readFile(filename, "utf8"), /^# Flight Director Contract/m);
  assert.ok(result.created.some((item) => item.endsWith("MANAGER.md#framework-asset-updated")));
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

test("recognized legacy role templates migrate transactionally while custom role content stays protected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aw-install-legacy-roles-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await mkdir(path.join(root, ".claude", "agents"), { recursive: true });
  await mkdir(path.join(root, ".codex", "agents"), { recursive: true });
  const legacy = "You are the Implementation specialist, dispatched by the Manager.\nRead docs/agent-operations/operating-contracts/ and authoritative role and contract versions.\n";
  await writeFile(path.join(root, ".claude", "agents", "implementation.md"), legacy);
  await writeFile(path.join(root, ".codex", "agents", "implementation.toml"), legacy);
  await installConsumer(root);
  assert.match(await readFile(path.join(root, ".claude", "agents", "implementation.md"), "utf8"), /Flight Software Engineer Mission Specialist/);
  assert.match(await readFile(path.join(root, ".codex", "agents", "implementation.toml"), "utf8"), /Flight Software Engineer Mission Specialist/);
  const customRoot = await mkdtemp(path.join(tmpdir(), "aw-install-custom-role-"));
  await writeFile(path.join(customRoot, "package.json"), "{}\n");
  await mkdir(path.join(customRoot, ".claude", "agents"), { recursive: true });
  await writeFile(path.join(customRoot, ".claude", "agents", "implementation.md"), "# My custom role\n");
  await assert.rejects(installConsumer(customRoot), /INSTALL_VALIDATION_FAILED/);
  assert.equal(await readFile(path.join(customRoot, ".claude", "agents", "implementation.md"), "utf8"), "# My custom role\n");
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
  await writeFile(agentsPath, canonical.replace("use the pinned Orbitkeep CLI with `--json` for canonical Operation", "use an unpinned workflow CLI for canonical Operation"));
  const planned = await planRepair(root);
  assert.ok(planned.actions.some((action) => action.path === "AGENTS.md" && action.action === "reconcile"));
  const applied = await applyRepair(root);
  const repaired = await readFile(agentsPath, "utf8");
  assert.match(repaired, /# Project rules[\s\S]*Keep me/);
  assert.match(repaired, /pinned Orbitkeep CLI with `--json` for canonical Operation/);
  assert.ok(applied.backupDirectory);
  assert.match(await readFile(path.join(applied.backupDirectory!, "AGENTS.md"), "utf8"), /unpinned workflow CLI/);
});
