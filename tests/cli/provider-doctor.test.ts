import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { providerDoctor } from "../../src/cli/diagnostics.ts";
import { installConsumer } from "../../src/installer/index.ts";

test("provider doctor verifies installation, authentication, streaming, and permission control without exposing account details", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-provider-doctor-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await installConsumer(root);
  const bin = path.join(root, "bin"); await mkdir(bin);
  const executable = path.join(bin, process.platform === "win32" ? "claude.cmd" : "claude");
  await writeFile(executable, process.platform === "win32"
    ? '@echo off\r\nif "%1"=="--help" (echo --setting-sources --settings --output-format) else (echo {"loggedIn":true,"email":"must-not-escape@example.com"})\r\n'
    : '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--setting-sources --settings --output-format"; else echo \'{"loggedIn":true,"email":"must-not-escape@example.com"}\'; fi\n', { mode: 0o755 });
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const environment = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, ORBITKEEP_CLAUDE_EXECUTABLE: executable };

  const report = await providerDoctor(root, "claude", environment);
  assert.equal(report.status, "ready");
  assert.equal(report.authentication.state, "authenticated");
  assert.equal(report.headlessExecution.supported, true);
  assert.match(report.headlessExecution.reason, /required headless options/);
  assert.equal(report.eventStreaming.normalized, true);
  assert.equal(report.permissionControl.state, "enforced");
  assert.doesNotMatch(JSON.stringify(report), /must-not-escape|@example\.com/);

  await writeFile(executable, process.platform === "win32"
    ? '@echo off\r\nif "%1"=="--help" (echo --output-format) else (echo {"loggedIn":true})\r\n'
    : '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--output-format"; else echo \'{"loggedIn":true}\'; fi\n', { mode: 0o755 });
  const incompatible = await providerDoctor(root, "claude", environment);
  assert.equal(incompatible.status, "attention_required");
  assert.equal(incompatible.headlessExecution.supported, false);
  assert.match(incompatible.headlessExecution.reason, /--setting-sources/);
});
