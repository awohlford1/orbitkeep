import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const consumerRoot = await mkdtemp(path.join(tmpdir(), "orbitkeep-package-"));
const npmEntryPoint = process.env.npm_execpath;
let tarball;

assert.ok(npmEntryPoint, "Run this smoke test through npm so its portable npm entry point is available");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`)));
  });
}

const runNpm = (args, cwd) => run(process.execPath, [npmEntryPoint, ...args], cwd);

try {
  const packed = await runNpm(["pack", "--json"], repositoryRoot);
  const entries = JSON.parse(packed.stdout);
  assert.equal(entries.length, 1, "npm pack must create exactly one package");
  tarball = path.join(repositoryRoot, entries[0].filename);

  await writeFile(path.join(consumerRoot, "package.json"), "{\"private\":true}\n");
  await runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], consumerRoot);

  const packageRoot = path.join(consumerRoot, "node_modules", "orbitkeep");
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, "orbitkeep");
  assert.equal(packageJson.bin["agent-workflow"], packageJson.bin.orbitkeep, "legacy CLI alias must resolve to Orbitkeep");
  await readFile(path.join(packageRoot, "docs", "domain-model.md"), "utf8");
  await readFile(path.join(packageRoot, "docs", "roadmap.md"), "utf8");
  await readFile(path.join(packageRoot, "docs", "sdk.md"), "utf8");
  await readFile(path.join(packageRoot, "docs", "release.md"), "utf8");
  await readFile(path.join(packageRoot, "docs", "release-qualification.md"), "utf8");
  await readFile(path.join(packageRoot, "SECURITY.md"), "utf8");
  await readFile(path.join(packageRoot, "SUPPORT.md"), "utf8");
  await readFile(path.join(packageRoot, "CHANGELOG.md"), "utf8");
  await readFile(path.join(packageRoot, "CONTRIBUTING.md"), "utf8");
  await assert.rejects(readFile(path.join(packageRoot, "docs", "specifications", "v0.5-silo-identity-lifecycle.md"), "utf8"), /ENOENT/, "internal implementation specifications are not runtime package assets");
  const imported = await import(pathToFileURL(path.join(packageRoot, packageJson.exports["."])).href);
  assert.equal(typeof imported.installConsumer, "function", "package root export must load");
  const silo = await import(pathToFileURL(path.join(packageRoot, packageJson.exports["./silo"])).href);
  assert.equal(typeof silo.SiloRegistrationService, "function", "Silo SDK export must load");
  assert.equal(typeof silo.SiloLifecycleRepository, "function", "Silo lifecycle SDK export must load");
  const relay = await import(pathToFileURL(path.join(packageRoot, packageJson.exports["./relay"])).href);
  assert.equal(typeof relay.InMemoryRelayTransport, "function", "Relay SDK export must load");
  await readFile(path.join(packageRoot, packageJson.exports["./schemas/relay-envelope.json"]), "utf8");
  const scheduling = await import(pathToFileURL(path.join(packageRoot, packageJson.exports["./scheduling"])).href);
  assert.equal(typeof scheduling.schedulingDecision, "function", "scheduling SDK export must load");
  const workflows = await import(pathToFileURL(path.join(packageRoot, packageJson.exports["./workflows"])).href);
  assert.equal(typeof workflows.validateWorkflowTemplate, "function", "workflow-template SDK export must load");
  const policy = await import(pathToFileURL(path.join(packageRoot, packageJson.exports["./policy"])).href);
  assert.equal(typeof policy.evaluateCharters, "function", "Charter policy SDK export must load");
  await readFile(path.join(packageRoot, packageJson.exports["./schemas/charter.json"]), "utf8");
  const templateSchema = JSON.parse(await readFile(path.join(packageRoot, packageJson.exports["./schemas/workflow-template.json"]), "utf8"));
  assert.equal(templateSchema.$id, "https://agent-workflow.dev/schemas/1.0/workflow-template.schema.json");
  const deliveryTemplate = JSON.parse(await readFile(path.join(packageRoot, packageJson.exports["./templates/software-delivery.json"]), "utf8"));
  assert.equal(workflows.validateWorkflowTemplate(deliveryTemplate).templateId, "tpl-software-delivery", "packaged template must validate through the public SDK");

  const cli = path.join(packageRoot, packageJson.bin.orbitkeep);
  const setup = await run(process.execPath, [cli, "setup", "--json", "--project-root", consumerRoot], consumerRoot);
  const result = JSON.parse(setup.stdout);
  assert.equal(result.status, "ready", `packed CLI setup failed: ${setup.stdout}`);
  assert.equal(result.health.activation, "active");
  process.stdout.write(`Package smoke test passed for ${packageJson.name}@${packageJson.version}.\n`);
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(consumerRoot, { recursive: true, force: true });
}
