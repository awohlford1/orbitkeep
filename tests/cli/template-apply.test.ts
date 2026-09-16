import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

function invoke(root: string, command: string[], input?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...command, "--json", "--project-root", root], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`CLI exited ${code}: ${stdout}\n${stderr}`));
      try { resolve(JSON.parse(stdout) as Record<string, unknown>); }
      catch (error) { reject(new Error(`CLI emitted invalid JSON: ${stdout}\n${stderr}`, { cause: error })); }
    });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}

test("template-apply works through the real CLI and persists canonical provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitkeep-template-cli-"));
  try {
    await writeFile(path.join(root, "package.json"), "{\"private\":true}\n", "utf8");
    await invoke(root, ["setup"]);
    const started = await invoke(root, ["start"], {
      objective: "Exercise reusable workflow",
      approach: ["Apply packaged template"],
      acceptanceCriteria: ["Canonical template provenance is persisted"],
      managerInstanceId: "mgr-template-cli",
    });
    const assignment = started.assignment as { assignmentId: string; ownershipLease: { token: string } };
    const template = JSON.parse(await readFile(new URL("../../templates/software-delivery.json", import.meta.url), "utf8"));
    const applied = await invoke(root, ["template-apply"], {
      assignmentId: assignment.assignmentId,
      applicationId: "tapp-cli-example",
      ownershipToken: assignment.ownershipLease.token,
      managerInstanceId: "mgr-template-cli",
      template,
      bindings: { affectedPaths: { implementation: ["src/**"] } },
    }) as { applicationId: string; operationBindings: Record<string, string> };
    assert.equal(applied.applicationId, "tapp-cli-example");
    assert.equal(Object.keys(applied.operationBindings).length, 6);

    const status = await invoke(root, ["status"], { assignmentId: assignment.assignmentId, managerInstanceId: "mgr-template-cli" });
    const current = status.assignment as { tasks: unknown[]; routes: unknown[]; templateApplications: unknown[] };
    assert.equal(current.tasks.length, 6);
    assert.equal(current.routes.length, 1);
    assert.equal(current.templateApplications.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
