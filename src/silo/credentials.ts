import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { withOperationLock } from "../concurrency/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { assertContainedStatePath, assertPortableId, initializeStateRoot, writeJsonAtomic, type JsonValue } from "../storage/index.ts";

export interface PublicKeyDescriptor {
  keyId: string;
  algorithm: "ed25519";
  publicKey: string;
  fingerprint: string;
  status: "active" | "overlap" | "retired";
  createdAt: string;
  retireAt?: string;
}

export interface CredentialProviderAssessment {
  available: boolean;
  protection: "hardened" | "local_file_degraded" | "unavailable";
  findings: string[];
}

export interface SiloCredentialProvider {
  createKey(keyId: string): Promise<PublicKeyDescriptor>;
  activateKey(keyId: string): Promise<PublicKeyDescriptor>;
  sign(keyId: string, payload: Uint8Array): Promise<Uint8Array>;
  retireKey(keyId: string): Promise<void>;
  assess(): Promise<CredentialProviderAssessment>;
}

interface StoredPublicKey {
  key_id: string;
  algorithm: "ed25519";
  public_key: string;
  fingerprint: string;
  status: "active" | "overlap" | "retired";
  created_at: string;
  retire_at?: string;
}

interface StoredKeyMetadata {
  schema_version: "1.0";
  silo_id: string;
  active_key_id: string;
  public_keys: StoredPublicKey[];
  provider: string;
  protection: "hardened" | "local_file_degraded" | "unavailable";
  updated_at: string;
}

const publicDescriptor = (key: StoredPublicKey): PublicKeyDescriptor => ({ keyId: key.key_id, algorithm: key.algorithm, publicKey: key.public_key, fingerprint: key.fingerprint, status: key.status, createdAt: key.created_at, ...(key.retire_at ? { retireAt: key.retire_at } : {}) });

export class LocalFileSiloCredentialProvider implements SiloCredentialProvider {
  private readonly projectRoot: string;
  private readonly stateDirectory: string;
  private readonly now: () => Date;

  constructor(projectRoot: string, stateDirectory = ".agent-state", now: () => Date = () => new Date()) {
    this.projectRoot = projectRoot; this.stateDirectory = stateDirectory; this.now = now;
  }

  private async context() {
    const { stateRoot } = await initializeStateRoot(this.projectRoot, this.stateDirectory);
    const descriptor = JSON.parse(await readFile(path.join(this.projectRoot, ".agent-workflow", "silo.json"), "utf8")) as { silo_id?: string };
    if (typeof descriptor.silo_id !== "string") throw Object.assign(new Error("SILO_IDENTITY_INVALID: a valid Silo descriptor is required before creating credentials."), { code: "SILO_IDENTITY_INVALID" });
    return { stateRoot, siloId: descriptor.silo_id };
  }

  private async metadata(stateRoot: string): Promise<StoredKeyMetadata | undefined> {
    try { return JSON.parse(await readFile(await assertContainedStatePath(stateRoot, path.join("registration", "keys.json")), "utf8")) as StoredKeyMetadata; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private validate(value: StoredKeyMetadata): void {
    const validation = coreSchemaRegistry.validateRecord("silo-key-metadata", value, "1.0");
    if (!validation.valid) throw Object.assign(new Error(`SILO_KEY_METADATA_INVALID: ${validation.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`).join("; ")}`), { code: "SILO_KEY_METADATA_INVALID" });
  }

  async createKey(keyId: string): Promise<PublicKeyDescriptor> {
    assertPortableId(keyId, "Silo key ID"); const { stateRoot, siloId } = await this.context();
    return withOperationLock({ stateRoot, resource: "silo-credentials", ownerId: `runtime-${process.pid}` }, async () => {
      const current = await this.metadata(stateRoot);
      if (current && current.silo_id !== siloId) throw Object.assign(new Error("SILO_KEY_METADATA_INVALID: key metadata belongs to a different Silo."), { code: "SILO_KEY_METADATA_INVALID" });
      const existing = current?.public_keys.find((key) => key.key_id === keyId);
      if (existing) return publicDescriptor(existing);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const fingerprint = `sha256:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
      const createdAt = this.now().toISOString(); const isInitial = current === undefined;
      const stored: StoredPublicKey = { key_id: keyId, algorithm: "ed25519", public_key: publicPem, fingerprint, status: isInitial ? "active" : "overlap", created_at: createdAt };
      const publicKeys = (current?.public_keys ?? []).concat(stored);
      const next: StoredKeyMetadata = { schema_version: "1.0", silo_id: siloId, active_key_id: current?.active_key_id ?? keyId, public_keys: publicKeys, provider: "local_file", protection: "local_file_degraded", updated_at: createdAt };
      this.validate(next);
      const privateRelative = path.join(".runtime", "credentials", "silo-keys", `${keyId}.pem`); const privatePath = await assertContainedStatePath(stateRoot, privateRelative);
      await mkdir(path.dirname(privatePath), { recursive: true });
      try {
        const handle = await open(privatePath, "wx", 0o600); try { await handle.writeFile(privatePem, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await chmod(privatePath, 0o600).catch(() => undefined);
        await writeJsonAtomic(stateRoot, path.join("registration", "keys.json"), next as unknown as JsonValue);
      } catch (error) { await rm(privatePath, { force: true }).catch(() => undefined); throw error; }
      return publicDescriptor(stored);
    });
  }

  async activateKey(keyId: string): Promise<PublicKeyDescriptor> {
    assertPortableId(keyId, "Silo key ID"); const { stateRoot, siloId } = await this.context();
    return withOperationLock({ stateRoot, resource: "silo-credentials", ownerId: `runtime-${process.pid}` }, async () => {
      const current = await this.metadata(stateRoot); const selected = current?.public_keys.find((item) => item.key_id === keyId);
      if (!current || current.silo_id !== siloId || !selected || selected.status === "retired") throw Object.assign(new Error("SILO_KEY_PROVIDER_UNAVAILABLE: requested activation key is unavailable."), { code: "SILO_KEY_PROVIDER_UNAVAILABLE" });
      const updatedAt = this.now().toISOString();
      for (const key of current.public_keys) if (key.status !== "retired") key.status = key.key_id === keyId ? "active" : "overlap";
      current.active_key_id = keyId; current.updated_at = updatedAt; this.validate(current);
      await writeJsonAtomic(stateRoot, path.join("registration", "keys.json"), current as unknown as JsonValue);
      return publicDescriptor(selected);
    });
  }

  async sign(keyId: string, payload: Uint8Array): Promise<Uint8Array> {
    assertPortableId(keyId, "Silo key ID"); const { stateRoot, siloId } = await this.context(); const metadata = await this.metadata(stateRoot);
    const key = metadata?.public_keys.find((item) => item.key_id === keyId);
    if (!metadata || metadata.silo_id !== siloId || !key || key.status === "retired") throw Object.assign(new Error("SILO_KEY_PROVIDER_UNAVAILABLE: requested signing key is unavailable."), { code: "SILO_KEY_PROVIDER_UNAVAILABLE" });
    try { return cryptoSign(null, payload, await readFile(await assertContainedStatePath(stateRoot, path.join(".runtime", "credentials", "silo-keys", `${keyId}.pem`)))); }
    catch { throw Object.assign(new Error("SILO_KEY_PROVIDER_UNAVAILABLE: requested signing key is unavailable."), { code: "SILO_KEY_PROVIDER_UNAVAILABLE" }); }
  }

  async retireKey(keyId: string): Promise<void> {
    assertPortableId(keyId, "Silo key ID"); const { stateRoot, siloId } = await this.context();
    await withOperationLock({ stateRoot, resource: "silo-credentials", ownerId: `runtime-${process.pid}` }, async () => {
      const current = await this.metadata(stateRoot); const key = current?.public_keys.find((item) => item.key_id === keyId);
      if (!current || current.silo_id !== siloId || !key) throw Object.assign(new Error("SILO_KEY_PROVIDER_UNAVAILABLE: requested key is unavailable."), { code: "SILO_KEY_PROVIDER_UNAVAILABLE" });
      if (current.active_key_id === keyId) throw Object.assign(new Error("SILO_KEY_ROTATION_PENDING: activate a replacement before retiring the current key."), { code: "SILO_KEY_ROTATION_PENDING" });
      const retiredAt = this.now().toISOString(); key.status = "retired"; key.retire_at = retiredAt; current.updated_at = retiredAt; this.validate(current);
      await writeJsonAtomic(stateRoot, path.join("registration", "keys.json"), current as unknown as JsonValue);
      await rm(await assertContainedStatePath(stateRoot, path.join(".runtime", "credentials", "silo-keys", `${keyId}.pem`)), { force: true });
    });
  }

  async assess(): Promise<CredentialProviderAssessment> {
    try {
      const { stateRoot, siloId } = await this.context(); const metadata = await this.metadata(stateRoot);
      if (!metadata) return { available: true, protection: "local_file_degraded", findings: ["Developer-preview local credential storage is available but no Silo key exists."] };
      if (metadata.silo_id !== siloId) return { available: false, protection: "unavailable", findings: ["Silo key metadata belongs to a different logical Silo."] };
      const privatePath = await assertContainedStatePath(stateRoot, path.join(".runtime", "credentials", "silo-keys", `${metadata.active_key_id}.pem`));
      await readFile(privatePath);
      return { available: true, protection: "local_file_degraded", findings: ["Private signing material uses local file protection and is not a hardened credential boundary."] };
    } catch { return { available: false, protection: "unavailable", findings: ["The active Silo signing key is unavailable or invalid."] }; }
  }
}
