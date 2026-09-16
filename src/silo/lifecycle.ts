import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../config/index.ts";
import { withOperationLock } from "../concurrency/index.ts";
import { appendEvent } from "../events/index.ts";
import { coreSchemaRegistry } from "../registries/index.ts";
import { initializeStateRoot, writeJsonAtomic, type JsonValue } from "../storage/index.ts";
import { inspectSiloIdentity } from "./identity.ts";

export type SiloConnectivityState = "offline" | "connecting" | "connected" | "disconnected";
export type SiloHealthState = "healthy" | "degraded" | "blocked";
export interface SiloHealthFinding { code: string; level: "enforced" | "observed" | "instructed" | "unsupported"; message: string }
export interface SiloCapabilitySnapshot { schema_version: "1.0"; silo_id: string; silo_instance_id: string; observed_at: string; capabilities: string[]; digest: string }
export interface SiloConnectionObservation { schema_version: "1.0"; silo_id: string; silo_instance_id: string; state: SiloConnectivityState; observed_at: string; valid_until?: string; session_id?: string; reason?: string }
export interface SiloHealthAssessment { schema_version: "1.0"; silo_id: string; silo_instance_id: string; state: SiloHealthState; assessed_at: string; findings: SiloHealthFinding[] }

const transitions: Readonly<Record<SiloConnectivityState, readonly SiloConnectivityState[]>> = {
  offline: ["connecting"], connecting: ["connected", "disconnected", "offline"], connected: ["disconnected"], disconnected: ["connecting", "offline"],
};

function validate(recordType: "silo-capabilities" | "silo-connection-observation" | "silo-health-assessment", value: unknown): void {
  const result = coreSchemaRegistry.validateRecord(recordType, value, "1.0");
  if (!result.valid) throw Object.assign(new Error(`SILO_LIFECYCLE_INVALID: ${result.errors.map((item) => `${item.instancePath || "/"}: ${item.message}`).join("; ")}`), { code: "SILO_LIFECYCLE_INVALID" });
}

export class SiloLifecycleRepository {
  private readonly projectRoot: string; private readonly stateDirectory: string; private readonly now: () => Date;
  constructor(projectRoot: string, stateDirectory = ".agent-state", now: () => Date = () => new Date()) { this.projectRoot = projectRoot; this.stateDirectory = stateDirectory; this.now = now; }

  private async context() {
    const { stateRoot } = await initializeStateRoot(this.projectRoot, this.stateDirectory); const identity = await inspectSiloIdentity(this.projectRoot, this.stateDirectory);
    if (!identity.valid || !identity.descriptor || !identity.instance) throw Object.assign(new Error("SILO_IDENTITY_INVALID: lifecycle observations require valid Silo identity."), { code: "SILO_IDENTITY_INVALID" });
    return { stateRoot, descriptor: identity.descriptor, instance: identity.instance };
  }

  async observeCapabilities(capabilities: string[]): Promise<SiloCapabilitySnapshot> {
    const context = await this.context(); const unique = [...new Set(capabilities)].sort();
    const snapshot: SiloCapabilitySnapshot = { schema_version: "1.0", silo_id: context.descriptor.silo_id, silo_instance_id: context.instance.silo_instance_id, observed_at: this.now().toISOString(), capabilities: unique, digest: `sha256:${createHash("sha256").update(canonicalJson(unique)).digest("hex")}` };
    validate("silo-capabilities", snapshot);
    await withOperationLock({ stateRoot: context.stateRoot, resource: "silo-lifecycle", ownerId: `runtime-${process.pid}` }, () => writeJsonAtomic(context.stateRoot, path.join("registration", "capabilities.json"), snapshot as unknown as JsonValue));
    await this.event("silo.capabilities_observed", context.descriptor.silo_id, context.instance.silo_instance_id, { silo_id: context.descriptor.silo_id, capability_digest: snapshot.digest }); return snapshot;
  }

  async observeConnection(state: SiloConnectivityState, input: { sessionId?: string; reason?: string; livenessSeconds?: number } = {}): Promise<SiloConnectionObservation> {
    const context = await this.context(); const filename = path.join(context.stateRoot, "registration", "connection.json");
    return withOperationLock({ stateRoot: context.stateRoot, resource: "silo-lifecycle", ownerId: `runtime-${process.pid}` }, async () => {
      const current = await readFile(filename, "utf8").then((value) => JSON.parse(value) as SiloConnectionObservation).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      const from = current?.state ?? "offline";
      if (!transitions[from].includes(state)) throw Object.assign(new Error(`SILO_CONNECTION_TRANSITION_INVALID: ${from} -> ${state}`), { code: "SILO_CONNECTION_TRANSITION_INVALID", from, to: state });
      const observed = this.now();
      if (state === "connected" && (!Number.isInteger(input.livenessSeconds ?? 60) || (input.livenessSeconds ?? 60) < 1)) throw Object.assign(new Error("SILO_CONNECTION_LIVENESS_INVALID: livenessSeconds must be a positive integer."), { code: "SILO_CONNECTION_LIVENESS_INVALID" });
      const observation: SiloConnectionObservation = { schema_version: "1.0", silo_id: context.descriptor.silo_id, silo_instance_id: context.instance.silo_instance_id, state, observed_at: observed.toISOString(), ...(state === "connected" ? { valid_until: new Date(observed.getTime() + (input.livenessSeconds ?? 60) * 1_000).toISOString() } : {}), ...(input.sessionId ? { session_id: input.sessionId } : {}), ...(input.reason ? { reason: input.reason } : {}) };
      validate("silo-connection-observation", observation); await writeJsonAtomic(context.stateRoot, path.join("registration", "connection.json"), observation as unknown as JsonValue);
      await this.event("silo.connection_changed", context.descriptor.silo_id, context.instance.silo_instance_id, { silo_id: context.descriptor.silo_id, state }); return observation;
    });
  }

  async assessHealth(findings: SiloHealthFinding[]): Promise<SiloHealthAssessment> {
    const context = await this.context(); const state: SiloHealthState = findings.some((item) => item.level === "unsupported") ? "blocked" : findings.some((item) => item.level === "instructed") ? "degraded" : "healthy";
    const assessment: SiloHealthAssessment = { schema_version: "1.0", silo_id: context.descriptor.silo_id, silo_instance_id: context.instance.silo_instance_id, state, assessed_at: this.now().toISOString(), findings: [...findings].sort((left, right) => left.code.localeCompare(right.code)) };
    validate("silo-health-assessment", assessment);
    await withOperationLock({ stateRoot: context.stateRoot, resource: "silo-lifecycle", ownerId: `runtime-${process.pid}` }, () => writeJsonAtomic(context.stateRoot, path.join("registration", "health.json"), assessment as unknown as JsonValue));
    await this.event("silo.health_assessed", context.descriptor.silo_id, context.instance.silo_instance_id, { silo_id: context.descriptor.silo_id, health_state: state }); return assessment;
  }

  private async event(eventType: string, siloId: string, instanceId: string, data: JsonValue): Promise<void> {
    const runtime = { actor_id: "runtime-orbitkeep", actor_type: "runtime" as const };
    await appendEvent({ projectRoot: this.projectRoot, stateDirectory: this.stateDirectory, operationId: `op-${randomUUID()}`, validator: { validate: (_id, value, version) => coreSchemaRegistry.validateEvent(value, version) }, schemaId: "event", event: { schema_version: "1.0", event_id: `evt-${randomUUID()}`, event_type: eventType, occurred_at: this.now().toISOString(), silo_id: siloId, silo_instance_id: instanceId, actor: runtime, recorded_by: runtime, data } });
  }
}
