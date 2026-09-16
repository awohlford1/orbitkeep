import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { withOperationLock } from "../concurrency/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { initializeStateRoot, writeJsonAtomic, type JsonValue } from "../storage/index.ts";
import type { SiloDescriptor, SiloIdentityDerivation, SiloIdentityInitialization, SiloIdentityInspection, SiloInstance, SiloOriginHint } from "./types.ts";

const executeFile = promisify(execFile);

function siloError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function validationMessage(recordType: string, value: unknown): string | undefined {
  const result = coreSchemaRegistry.validateRecord(recordType, value, "1.0");
  return result.valid ? undefined : result.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`).join("; ");
}

async function readJson(filename: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(filename, "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw siloError("SILO_IDENTITY_INVALID", "Silo identity contains malformed JSON.");
    throw error;
  }
}

async function writeDescriptorAtomic(filename: string, descriptor: SiloDescriptor, exclusive: boolean): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  if (exclusive) {
    const handle = await open(filename, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return;
  }
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

function parseOriginHint(value: string): SiloOriginHint | undefined {
  const cleaned = value.trim().replace(/\.git$/i, "");
  let host = ""; let repository = "";
  const scp = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(cleaned);
  if (scp && !/^[A-Za-z]:[\\/]/.test(cleaned)) { host = scp[1]!.toLowerCase(); repository = scp[2]!; }
  else {
    try { const parsed = new URL(cleaned); host = parsed.hostname.toLowerCase(); repository = parsed.pathname.replace(/^\/+/, ""); }
    catch { return undefined; }
  }
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(repository)) return undefined;
  const provider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : host === "bitbucket.org" ? "bitbucket" : "other";
  return { provider, repository };
}

export async function detectSiloOriginHint(projectRoot: string): Promise<SiloOriginHint | undefined> {
  try {
    const result = await executeFile("git", ["config", "--get", "remote.origin.url"], { cwd: projectRoot, windowsHide: true, timeout: 3_000 });
    return parseOriginHint(result.stdout);
  } catch { return undefined; }
}

function workspaceFingerprint(projectRoot: string, siloId: string): string {
  const normalized = process.platform === "win32" ? path.resolve(projectRoot).toLowerCase() : path.resolve(projectRoot);
  return `sha256:${createHash("sha256").update(`${siloId}\0${normalized}`).digest("hex")}`;
}

export async function inspectSiloIdentity(projectRoot: string, stateDirectory = ".agent-state"): Promise<SiloIdentityInspection> {
  const descriptorPath = path.join(projectRoot, ".agent-workflow", "silo.json");
  const instancePath = path.join(projectRoot, stateDirectory, ".runtime", "silo-instance.json");
  const errors: SiloIdentityInspection["errors"] = [];
  let descriptor: SiloDescriptor | undefined; let instance: SiloInstance | undefined;
  try {
    const value = await readJson(descriptorPath);
    if (value === undefined) errors.push({ code: "SILO_IDENTITY_MISSING", message: "Logical Silo descriptor is missing." });
    else { const invalid = validationMessage("silo-descriptor", value); if (invalid) errors.push({ code: "SILO_IDENTITY_INVALID", message: `Logical Silo descriptor is invalid: ${invalid}` }); else descriptor = value as SiloDescriptor; }
  } catch (error) { errors.push({ code: "SILO_IDENTITY_INVALID", message: error instanceof Error ? error.message : String(error) }); }
  try {
    const value = await readJson(instancePath);
    if (value === undefined) errors.push({ code: "SILO_IDENTITY_MISSING", message: "Local Silo instance record is missing." });
    else { const invalid = validationMessage("silo-instance", value); if (invalid) errors.push({ code: "SILO_IDENTITY_INVALID", message: `Local Silo instance record is invalid: ${invalid}` }); else instance = value as SiloInstance; }
  } catch (error) { errors.push({ code: "SILO_IDENTITY_INVALID", message: error instanceof Error ? error.message : String(error) }); }
  if (descriptor && instance && descriptor.silo_id !== instance.silo_id) errors.push({ code: "SILO_INSTANCE_MISMATCH", message: "Local Silo instance is bound to a different logical Silo." });
  return { valid: errors.length === 0, ...(descriptor ? { descriptor } : {}), ...(instance ? { instance } : {}), errors };
}

export async function ensureSiloIdentity(projectRoot: string, stateDirectory = ".agent-state", input: { now?: () => Date; id?: () => string; originHint?: SiloOriginHint | null } = {}): Promise<SiloIdentityInitialization> {
  const root = path.resolve(projectRoot); const { stateRoot } = await initializeStateRoot(root, stateDirectory);
  const now = input.now ?? (() => new Date()); const id = input.id ?? randomUUID;
  return withOperationLock({ stateRoot, resource: "silo-identity", ownerId: `runtime-${process.pid}` }, async () => {
    const descriptorPath = path.join(root, ".agent-workflow", "silo.json");
    const instanceRelative = path.join(".runtime", "silo-instance.json"); const instancePath = path.join(stateRoot, instanceRelative);
    const currentInstance = await readJson(instancePath);
    const currentDescriptor = await readJson(descriptorPath);
    let descriptor: SiloDescriptor; let descriptorCreated = false;
    if (currentDescriptor === undefined) {
      if (currentInstance !== undefined) throw siloError("SILO_IDENTITY_MISSING", "Logical Silo descriptor is missing while a local instance still exists; manual recovery is required.");
      const at = now().toISOString(); const originHint = input.originHint === null ? undefined : input.originHint ?? await detectSiloOriginHint(root);
      descriptor = { schema_version: "1.0", silo_id: `silo-${id()}`, created_at: at, identity_version: 1, ...(originHint ? { origin_hint: originHint } : {}) };
      const invalid = validationMessage("silo-descriptor", descriptor); if (invalid) throw siloError("SILO_IDENTITY_INVALID", invalid);
      await writeDescriptorAtomic(descriptorPath, descriptor, true); descriptorCreated = true;
    } else {
      const invalid = validationMessage("silo-descriptor", currentDescriptor); if (invalid) throw siloError("SILO_IDENTITY_INVALID", invalid);
      descriptor = currentDescriptor as SiloDescriptor;
    }
    let instance: SiloInstance; let instanceCreated = false;
    if (currentInstance === undefined) {
      const at = now().toISOString();
      instance = { schema_version: "1.0", silo_instance_id: `sinst-${id()}`, silo_id: descriptor.silo_id, created_at: at, last_started_at: at, instance_version: 1, workspace_fingerprint: workspaceFingerprint(root, descriptor.silo_id) };
      const invalid = validationMessage("silo-instance", instance); if (invalid) throw siloError("SILO_IDENTITY_INVALID", invalid);
      await writeJsonAtomic(stateRoot, instanceRelative, instance as unknown as JsonValue); instanceCreated = true;
    } else {
      const invalid = validationMessage("silo-instance", currentInstance); if (invalid) throw siloError("SILO_IDENTITY_INVALID", invalid);
      instance = currentInstance as SiloInstance;
      if (instance.silo_id !== descriptor.silo_id) throw siloError("SILO_INSTANCE_MISMATCH", "Local Silo instance is bound to a different logical Silo.");
    }
    return { descriptor, instance, descriptorCreated, instanceCreated };
  });
}

/** Internal mutation primitive. Callers must hold the Silo identity operation lock. */
export async function replaceSiloIdentity(projectRoot: string, stateDirectory = ".agent-state", input: { now?: () => Date; id?: () => string } = {}): Promise<SiloIdentityDerivation> {
  const root = path.resolve(projectRoot); const { stateRoot } = await initializeStateRoot(root, stateDirectory);
  const current = await inspectSiloIdentity(root, stateDirectory);
  if (!current.valid || !current.descriptor || !current.instance) throw siloError("SILO_IDENTITY_INVALID", current.errors.map((item) => item.message).join("; "));
  const now = input.now ?? (() => new Date()); const id = input.id ?? randomUUID; const at = now().toISOString();
  const descriptor: SiloDescriptor = {
    schema_version: "1.0", silo_id: `silo-${id()}`, created_at: at, identity_version: 1,
    derived_from_silo_id: current.descriptor.silo_id,
    ...(current.descriptor.origin_hint ? { origin_hint: current.descriptor.origin_hint } : {}),
  };
  const instance: SiloInstance = {
    schema_version: "1.0", silo_instance_id: `sinst-${id()}`, silo_id: descriptor.silo_id,
    created_at: at, last_started_at: at, instance_version: 1,
    workspace_fingerprint: workspaceFingerprint(root, descriptor.silo_id),
  };
  const descriptorError = validationMessage("silo-descriptor", descriptor); if (descriptorError) throw siloError("SILO_IDENTITY_INVALID", descriptorError);
  const instanceError = validationMessage("silo-instance", instance); if (instanceError) throw siloError("SILO_IDENTITY_INVALID", instanceError);
  await writeDescriptorAtomic(path.join(root, ".agent-workflow", "silo.json"), descriptor, false);
  await writeJsonAtomic(stateRoot, path.join(".runtime", "silo-instance.json"), instance as unknown as JsonValue);
  return { previousSiloId: current.descriptor.silo_id, descriptor, instance };
}
