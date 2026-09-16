import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));

function git(args, failureCode) {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`${failureCode}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "RELEASE_PREFLIGHT_INVALID_VERSION");
assert.equal(packageLock.name, packageJson.name, "RELEASE_PREFLIGHT_LOCK_NAME_MISMATCH");
assert.equal(packageLock.version, packageJson.version, "RELEASE_PREFLIGHT_LOCK_VERSION_MISMATCH");
assert.equal(packageLock.packages?.[""]?.version, packageJson.version, "RELEASE_PREFLIGHT_ROOT_LOCK_VERSION_MISMATCH");

const versionSource = readFileSync(path.join(repositoryRoot, "src", "version.ts"), "utf8");
const sourceVersion = versionSource.match(/FRAMEWORK_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
assert.equal(sourceVersion, packageJson.version, "RELEASE_PREFLIGHT_SOURCE_VERSION_MISMATCH");
const changelog = readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
assert.ok(changelog.includes(`## [${packageJson.version}]`), "RELEASE_PREFLIGHT_CHANGELOG_ENTRY_MISSING");

let status;
try {
  status = git(["status", "--porcelain=v1", "--untracked-files=all"], "RELEASE_PREFLIGHT_GIT_REQUIRED");
} catch (error) {
  throw new Error(`RELEASE_PREFLIGHT_GIT_REQUIRED: publication must run from a Git checkout (${error instanceof Error ? error.message : String(error)})`);
}

if (status.trim() !== "") {
  throw new Error(`RELEASE_PREFLIGHT_DIRTY_TREE: commit or remove every working-tree change before publishing ${packageJson.name}@${packageJson.version}.\n${status.trim()}`);
}

const branch = git(["symbolic-ref", "--short", "HEAD"], "RELEASE_PREFLIGHT_BRANCH_REQUIRED");
assert.equal(branch, "main", `RELEASE_PREFLIGHT_MAIN_REQUIRED: current branch is ${branch}`);
const head = git(["rev-parse", "HEAD"], "RELEASE_PREFLIGHT_HEAD_REQUIRED");
const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], "RELEASE_PREFLIGHT_UPSTREAM_REQUIRED");
const upstreamHead = git(["rev-parse", "@{u}"], "RELEASE_PREFLIGHT_UPSTREAM_REQUIRED");
assert.equal(upstreamHead, head, `RELEASE_PREFLIGHT_UPSTREAM_MISMATCH: ${branch} is not at ${upstream}`);
assert.equal(git(["tag", "--list", `v${packageJson.version}`], "RELEASE_PREFLIGHT_TAG_CHECK_FAILED"), "", `RELEASE_PREFLIGHT_TAG_EXISTS: v${packageJson.version}`);
process.stdout.write(`Release preflight passed for ${packageJson.name}@${packageJson.version} at ${head} (${upstream}).\n`);
