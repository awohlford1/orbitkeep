import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const npmEntry = process.env.npm_execpath;
assert.ok(npmEntry, "PACKAGE_POLICY_NPM_REQUIRED: run through npm");

const output = execFileSync(process.execPath, [npmEntry, "pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const packed = JSON.parse(output)[0];
assert.ok(packed, "PACKAGE_POLICY_EMPTY: npm returned no artifact");
const files = new Set(packed.files.map((entry) => entry.path.replaceAll("\\", "/")));

const allowed = ["LICENSE", "README.md", "SECURITY.md", "SUPPORT.md", "CHANGELOG.md", "CONTRIBUTING.md", "package.json"];
const allowedPrefixes = ["contracts/", "defaults/", "dist/", "integrations/", "roles/", "schemas/", "templates/", "docs/"];
const forbiddenPrefixes = [".agent-state/", ".agent-workflow/", ".git/", ".github/", "src/", "tests/", "docs/specifications/"];
const forbiddenNames = /(^|\/)(\.env(?:\..*)?|[^/]+\.(?:pem|key|p12|pfx|tgz))$/i;

for (const file of files) {
  assert.ok(allowed.includes(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix)), `PACKAGE_POLICY_UNEXPECTED_FILE: ${file}`);
  assert.ok(!forbiddenPrefixes.some((prefix) => file.startsWith(prefix)), `PACKAGE_POLICY_FORBIDDEN_FILE: ${file}`);
  assert.ok(!forbiddenNames.test(file), `PACKAGE_POLICY_SECRET_OR_ARCHIVE: ${file}`);
}
for (const required of ["LICENSE", "README.md", "SECURITY.md", "SUPPORT.md", "CHANGELOG.md", "CONTRIBUTING.md", "package.json", "docs/release.md", "docs/sdk.md", "docs/release-qualification.md", "dist/cli/index.js", "dist/index.js", "schemas/1.0/config.schema.json"]) assert.ok(files.has(required), `PACKAGE_POLICY_REQUIRED_FILE_MISSING: ${required}`);
for (const target of [...Object.values(manifest.exports), ...Object.values(manifest.bin)]) {
  const normalized = String(target).replace(/^\.\//, "");
  assert.ok(files.has(normalized), `PACKAGE_POLICY_EXPORT_MISSING: ${target}`);
  if (normalized.startsWith("dist/") && normalized.endsWith(".js")) {
    assert.ok(files.has(normalized.replace(/\.js$/, ".d.ts")), `PACKAGE_POLICY_DECLARATION_MISSING: ${target}`);
  }
}

assert.equal(lock.name, manifest.name, "PACKAGE_POLICY_LOCK_NAME_MISMATCH");
assert.equal(lock.version, manifest.version, "PACKAGE_POLICY_LOCK_VERSION_MISMATCH");
assert.equal(lock.packages?.[""]?.version, manifest.version, "PACKAGE_POLICY_ROOT_LOCK_VERSION_MISMATCH");
assert.equal(manifest.engines?.node, ">=24 <25", "PACKAGE_POLICY_NODE_RANGE_CHANGED");
assert.ok(packed.unpackedSize < 2_000_000, `PACKAGE_POLICY_SIZE_EXCEEDED: ${packed.unpackedSize}`);
assert.ok(packed.entryCount < 1000, `PACKAGE_POLICY_ENTRY_COUNT_EXCEEDED: ${packed.entryCount}`);
process.stdout.write(`Package policy passed: ${packed.entryCount} files, ${packed.unpackedSize} unpacked bytes, ${packed.integrity}.\n`);
