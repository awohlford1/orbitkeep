import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign as cryptoSign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../config/index.ts";
import { appendEvent } from "../events/index.ts";
import { createPendingAction, quarantineSubmission, readPendingAction, reconcilePendingAction } from "../reconciliation/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { initializeStateRoot, writeJsonAtomic, type JsonValue } from "../storage/index.ts";
import { withOperationLock } from "../concurrency/index.ts";
import { inspectSiloIdentity } from "./identity.ts";
import type { SiloCredentialProvider } from "./credentials.ts";

export interface RegistrationRequest {
  schema_version: "1.0"; request_id: string; idempotency_id: string; silo_id: string; silo_instance_id: string;
  public_key: string; key_id: string; keep_id: string; colony_id?: string; capability_digest: string;
  charter: { schema_version: string; charter_id?: string; digest?: string }; issued_at: string; expires_at: string; nonce: string; signature: string;
}
export interface RegistrationReceipt {
  schema_version: "1.0"; registration_id: string; registration_version: number; silo_id: string; public_key_fingerprint: string;
  keep_id: string; colony_id?: string; granted_capabilities: string[]; charter: { charter_id: string; version: string; digest: string };
  status: "active" | "revoked" | "expired" | "retired"; issued_at: string; expires_at?: string; revalidate_at: string;
  authority_key_id: string; idempotency_id: string; signature: string;
}
export type RegistrationResponse = { status: "granted"; receipt: RegistrationReceipt } | { status: "rejected"; reason: string } | { status: "unknown"; reason: string };
export interface KeyRotationRequest { siloId: string }
export interface KeyRotationResponse { status: "granted" | "rejected" | "unknown"; reason?: string }
export interface RetirementRequest { siloId: string }
export interface RetirementResponse { status: "retired" | "rejected" | "unknown"; reason?: string }
export interface DisconnectRequest { siloId: string; mode: "graceful" | "force" }
export interface DisconnectResponse { status: "disconnected" | "unknown"; reason?: string }
export interface SiloRegistrationClient {
  register(request: RegistrationRequest): Promise<RegistrationResponse>;
  rotateKey(request: KeyRotationRequest): Promise<KeyRotationResponse>;
  retire(request: RetirementRequest): Promise<RetirementResponse>;
  disconnect(request: DisconnectRequest): Promise<DisconnectResponse>;
}

const unsigned = <T extends { signature: string }>(value: T): Omit<T, "signature"> => { const { signature: _signature, ...payload } = value; return payload; };
const bytes = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const sha256 = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
async function readOptional<T>(filename: string): Promise<T | undefined> { try { return JSON.parse(await readFile(filename, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }

export function registrationReceiptErrors(receipt: unknown, request: RegistrationRequest | undefined, trustedAuthorityKeys: Record<string, string>, observedAt = new Date()): string[] {
  const validation = coreSchemaRegistry.validateRecord("silo-registration-receipt", receipt, "1.0");
  if (!validation.valid) return validation.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`);
  const value = receipt as RegistrationReceipt; const errors: string[] = [];
  if (!request) errors.push("The registration request needed to verify receipt scope is missing.");
  else {
    const fingerprint = `sha256:${createHash("sha256").update(createPublicKey(request.public_key).export({ type: "spki", format: "der" })).digest("hex")}`;
    if (value.silo_id !== request.silo_id || value.keep_id !== request.keep_id || value.colony_id !== request.colony_id || value.idempotency_id !== request.idempotency_id || value.public_key_fingerprint !== fingerprint) errors.push("Receipt identity, membership, idempotency, or public-key scope does not match its request.");
  }
  if (value.status !== "active") errors.push(`Registration receipt status is ${value.status}.`);
  if (Date.parse(value.issued_at) > observedAt.getTime() || Date.parse(value.revalidate_at) <= observedAt.getTime() || (value.expires_at !== undefined && Date.parse(value.expires_at) <= observedAt.getTime())) errors.push("Registration receipt is outside its accepted validity window.");
  const authority = trustedAuthorityKeys[value.authority_key_id];
  if (!authority) errors.push(`No trusted authority key is configured for ${value.authority_key_id}.`);
  else {
    try { if (!verify(null, bytes(unsigned(value)), createPublicKey(authority), Buffer.from(value.signature, "base64"))) errors.push("Registration receipt signature is invalid."); }
    catch { errors.push("Registration receipt signature or authority key is invalid."); }
  }
  return errors;
}

export class InMemorySiloRegistrationClient implements SiloRegistrationClient {
  readonly authorityKeyId: string; readonly authorityPublicKey: string;
  private readonly authorityPrivateKey: string; private readonly responses = new Map<string, { digest: string; response: RegistrationResponse }>();
  private readonly now: () => Date; private readonly id: () => string;
  constructor(input: { authorityKeyId?: string; now?: () => Date; id?: () => string } = {}) {
    const pair = generateKeyPairSync("ed25519"); this.authorityKeyId = input.authorityKeyId ?? "keep-authority-dev";
    this.authorityPublicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString(); this.authorityPrivateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    this.now = input.now ?? (() => new Date()); this.id = input.id ?? randomUUID;
  }
  async register(request: RegistrationRequest): Promise<RegistrationResponse> {
    const digest = sha256(request); const prior = this.responses.get(request.idempotency_id);
    if (prior) { if (prior.digest !== digest) throw Object.assign(new Error("SILO_REGISTRATION_INVALID: idempotency key was reused with different content."), { code: "SILO_REGISTRATION_INVALID" }); return prior.response; }
    const requestValidation = coreSchemaRegistry.validateRecord("silo-registration-request", request, "1.0");
    if (!requestValidation.valid || !verify(null, bytes(unsigned(request)), createPublicKey(request.public_key), Buffer.from(request.signature, "base64"))) {
      const response = { status: "rejected" as const, reason: "Registration request signature or structure is invalid." }; this.responses.set(request.idempotency_id, { digest, response }); return response;
    }
    const now = this.now(); const receiptBase = {
      schema_version: "1.0" as const, registration_id: `sreg-${this.id()}`, registration_version: 1, silo_id: request.silo_id,
      public_key_fingerprint: `sha256:${createHash("sha256").update(createPublicKey(request.public_key).export({ type: "spki", format: "der" })).digest("hex")}`,
      keep_id: request.keep_id, ...(request.colony_id ? { colony_id: request.colony_id } : {}), granted_capabilities: [] as string[],
      charter: { charter_id: request.charter.charter_id ?? "charter-local", version: request.charter.schema_version, digest: request.charter.digest ?? sha256(request.charter) },
      status: "active" as const, issued_at: now.toISOString(), revalidate_at: new Date(now.getTime() + 3_600_000).toISOString(), authority_key_id: this.authorityKeyId, idempotency_id: request.idempotency_id,
    };
    const receipt: RegistrationReceipt = { ...receiptBase, signature: cryptoSign(null, bytes(receiptBase), this.authorityPrivateKey).toString("base64") };
    const response = { status: "granted" as const, receipt }; this.responses.set(request.idempotency_id, { digest, response }); return response;
  }
  async rotateKey(_request: KeyRotationRequest): Promise<KeyRotationResponse> { return { status: "unknown", reason: "Not implemented by the in-memory v0.5 registration adapter." }; }
  async retire(_request: RetirementRequest): Promise<RetirementResponse> { return { status: "unknown", reason: "Not implemented by the in-memory v0.5 registration adapter." }; }
  async disconnect(_request: DisconnectRequest): Promise<DisconnectResponse> { return { status: "disconnected" }; }
}

export interface RegisterSiloInput {
  keyId: string; keepId: string; colonyId?: string; capabilities?: string[];
  charter: { schemaVersion: string; charterId?: string; digest?: string };
  idempotencyId?: string; ttlSeconds?: number;
}

export class SiloRegistrationService {
  private readonly options: { projectRoot: string; stateDirectory?: string; credentials: SiloCredentialProvider; client: SiloRegistrationClient; trustedAuthorityKeys: Record<string, string>; now?: () => Date; id?: () => string };
  constructor(options: { projectRoot: string; stateDirectory?: string; credentials: SiloCredentialProvider; client: SiloRegistrationClient; trustedAuthorityKeys: Record<string, string>; now?: () => Date; id?: () => string }) { this.options = options; }

  async register(input: RegisterSiloInput): Promise<RegistrationResponse> {
    const stateDirectory = this.options.stateDirectory ?? ".agent-state"; const { stateRoot } = await initializeStateRoot(this.options.projectRoot, stateDirectory);
    return withOperationLock({ stateRoot, resource: "silo-registration", ownerId: `runtime-${process.pid}` }, () => this.registerLocked(input, stateDirectory, stateRoot));
  }

  private async registerLocked(input: RegisterSiloInput, stateDirectory: string, stateRoot: string): Promise<RegistrationResponse> {
    const identity = await inspectSiloIdentity(this.options.projectRoot, stateDirectory);
    if (!identity.valid || !identity.descriptor || !identity.instance) throw Object.assign(new Error("SILO_IDENTITY_INVALID: valid logical and instance identities are required."), { code: "SILO_IDENTITY_INVALID" });
    const receiptPath = path.join(stateRoot, "registration", "receipt.json"); const existingReceipt = await readOptional<RegistrationReceipt>(receiptPath);
    if (existingReceipt) {
      if (input.idempotencyId && input.idempotencyId === existingReceipt.idempotency_id) return { status: "granted", receipt: existingReceipt };
      throw Object.assign(new Error("SILO_ALREADY_REGISTERED: revoke or retire the existing registration first."), { code: "SILO_ALREADY_REGISTERED" });
    }
    const now = this.options.now ?? (() => new Date()); const id = this.options.id ?? randomUUID;
    const requestPath = path.join(stateRoot, "registration", "request.json"); const existingRequest = await readOptional<RegistrationRequest>(requestPath);
    let request: RegistrationRequest;
    if (existingRequest) {
      if ((input.idempotencyId && input.idempotencyId !== existingRequest.idempotency_id) || input.keepId !== existingRequest.keep_id || input.colonyId !== existingRequest.colony_id) throw Object.assign(new Error("SILO_REGISTRATION_PENDING: an unresolved registration request already exists with different scope."), { code: "SILO_REGISTRATION_PENDING" });
      request = existingRequest;
    } else {
      const issued = now(); const key = await this.options.credentials.createKey(input.keyId); const capabilities = [...new Set(input.capabilities ?? [])].sort(); const idempotencyId = input.idempotencyId ?? `idem-${id()}`;
      const requestBase = {
      schema_version: "1.0" as const, request_id: `sreq-${id()}`, idempotency_id: idempotencyId, silo_id: identity.descriptor.silo_id, silo_instance_id: identity.instance.silo_instance_id,
      public_key: key.publicKey, key_id: key.keyId, keep_id: input.keepId, ...(input.colonyId ? { colony_id: input.colonyId } : {}), capability_digest: sha256(capabilities),
      charter: { schema_version: input.charter.schemaVersion, ...(input.charter.charterId ? { charter_id: input.charter.charterId } : {}), ...(input.charter.digest ? { digest: input.charter.digest } : {}) },
      issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + (input.ttlSeconds ?? 300) * 1_000).toISOString(), nonce: `nonce-${id()}`,
      };
      request = { ...requestBase, signature: Buffer.from(await this.options.credentials.sign(key.keyId, bytes(requestBase))).toString("base64") };
      const requestValidation = coreSchemaRegistry.validateRecord("silo-registration-request", request, "1.0");
      if (!requestValidation.valid) throw Object.assign(new Error(`SILO_REGISTRATION_INVALID: ${requestValidation.errors.map((item) => item.message).join("; ")}`), { code: "SILO_REGISTRATION_INVALID" });
      await writeJsonAtomic(stateRoot, path.join("registration", "request.json"), request as unknown as JsonValue);
      await this.event(stateDirectory, identity.descriptor.silo_id, identity.instance.silo_instance_id, "silo.registration_requested", { silo_id: identity.descriptor.silo_id, request_id: request.request_id });
    }
    const response = await this.options.client.register(request);
    const actionId = `act-registration-${request.request_id.slice("sreq-".length)}`;
    if (response.status === "rejected") { await this.reconcileIfPending(stateRoot, actionId, identity.descriptor.silo_id, request.request_id, "failed", response.reason); await this.event(stateDirectory, identity.descriptor.silo_id, identity.instance.silo_instance_id, "silo.registration_rejected", { silo_id: identity.descriptor.silo_id, request_id: request.request_id, reason: response.reason }); return response; }
    if (response.status === "unknown") {
      const pendingId = `pending-${actionId}`;
      await createPendingAction(stateRoot, { schema_version: "1.0", record_id: pendingId, record_type: "pending", created_at: now().toISOString(), pending_id: pendingId, action_id: actionId, silo_id: identity.descriptor.silo_id, request_id: request.request_id, status: "unresolved", observed_outcome: "unknown" });
      return response;
    }
    try { this.validateReceipt(response.receipt, request, now()); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error); const quarantineId = `qua-${id()}`;
      await quarantineSubmission(stateRoot, { schema_version: "1.0", record_id: quarantineId, record_type: "quarantine", created_at: now().toISOString(), quarantine_id: quarantineId, submission: response.receipt as unknown as JsonValue, validation_errors: [{ code: "SILO_REGISTRATION_INVALID", message, instance_path: "/" }], status: "unresolved" });
      throw error;
    }
    await writeJsonAtomic(stateRoot, path.join("registration", "receipt.json"), response.receipt as unknown as JsonValue);
    await this.reconcileIfPending(stateRoot, actionId, identity.descriptor.silo_id, request.request_id, "succeeded", "A valid signed registration receipt was accepted.");
    await this.event(stateDirectory, identity.descriptor.silo_id, identity.instance.silo_instance_id, "silo.registration_granted", { silo_id: identity.descriptor.silo_id, request_id: request.request_id, registration_id: response.receipt.registration_id });
    return response;
  }

  private validateReceipt(receipt: RegistrationReceipt, request: RegistrationRequest, observedAt: Date): void {
    const errors = registrationReceiptErrors(receipt, request, this.options.trustedAuthorityKeys, observedAt);
    if (errors.length) throw Object.assign(new Error(`SILO_REGISTRATION_INVALID: ${errors.join("; ")}`), { code: "SILO_REGISTRATION_INVALID" });
  }

  private async reconcileIfPending(stateRoot: string, actionId: string, siloId: string, requestId: string, outcome: "succeeded" | "failed", rationale: string): Promise<void> {
    if (!await readPendingAction(stateRoot, actionId)) return;
    const operationId = `op-${randomUUID()}`; const reconciliationId = `rec-${randomUUID()}`;
    await reconcilePendingAction(stateRoot, actionId, { schema_version: "1.0", record_id: reconciliationId, record_type: "action-reconciliation", created_at: (this.options.now ?? (() => new Date()))().toISOString(), reconciliation_id: reconciliationId, action_id: actionId, silo_id: siloId, request_id: requestId, operation_id: operationId, outcome, reconciled_at: (this.options.now ?? (() => new Date()))().toISOString(), rationale });
  }

  private async event(stateDirectory: string, siloId: string, instanceId: string, eventType: string, data: JsonValue): Promise<void> {
    const runtime = { actor_id: "runtime-orbitkeep", actor_type: "runtime" as const };
    await appendEvent({ projectRoot: this.options.projectRoot, stateDirectory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: { schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: eventType, occurred_at: (this.options.now ?? (() => new Date()))().toISOString(), silo_id: siloId, silo_instance_id: instanceId, actor: runtime, recorded_by: runtime, data } });
  }
}
