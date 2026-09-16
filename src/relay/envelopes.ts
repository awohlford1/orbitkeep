import { createHash, verify as cryptoVerify } from "node:crypto";
import { canonicalJson } from "../config/index.ts";
import type { SiloCredentialProvider } from "../silo/index.ts";
import type { JsonValue } from "../storage/index.ts";
import type { RelayEnvelope, RelayMessageKind, RelaySender } from "./types.ts";

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const portable = /^[A-Za-z][A-Za-z0-9._:-]*$/;

export function relayPayloadDigest(payload: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

export function relaySigningBytes(envelope: Omit<RelayEnvelope, "signature">): Uint8Array {
  return Buffer.from(canonicalJson(envelope), "utf8");
}

export function validateRelayEnvelope(envelope: RelayEnvelope): void {
  const allowed = ["protocolVersion", "messageId", "streamId", "sequence", "kind", "sentAt", "sender", "payload", "payloadDigest", "correlationId", "causationId", "signature"];
  const unknown = Object.keys(envelope).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`RELAY_ENVELOPE_INVALID: unknown properties ${unknown.join(", ")}`);
  const unknownSender = Object.keys(envelope.sender ?? {}).filter((key) => !["siloId", "siloInstanceId", "keyId"].includes(key));
  if (unknownSender.length) throw new Error(`RELAY_ENVELOPE_INVALID: unknown sender properties ${unknownSender.join(", ")}`);
  if (envelope.protocolVersion !== "1.0") throw new Error("RELAY_PROTOCOL_UNSUPPORTED");
  for (const [name, value] of [["messageId", envelope.messageId], ["streamId", envelope.streamId], ["siloId", envelope.sender.siloId], ["siloInstanceId", envelope.sender.siloInstanceId], ["keyId", envelope.sender.keyId]] as const) {
    if (!portable.test(value)) throw new Error(`RELAY_ENVELOPE_INVALID: ${name}`);
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new Error("RELAY_SEQUENCE_INVALID");
  if (!(["command", "event", "status", "handover"] as RelayMessageKind[]).includes(envelope.kind)) throw new Error("RELAY_KIND_INVALID");
  if (!utc.test(envelope.sentAt)) throw new Error("RELAY_TIMESTAMP_INVALID");
  if (envelope.payloadDigest !== relayPayloadDigest(envelope.payload)) throw new Error("RELAY_PAYLOAD_DIGEST_MISMATCH");
  if (!envelope.signature) throw new Error("RELAY_SIGNATURE_REQUIRED");
}

export async function createSignedRelayEnvelope(input: {
  messageId: string; streamId: string; sequence: number; kind: RelayMessageKind; sentAt: string;
  sender: RelaySender; payload: JsonValue; correlationId?: string; causationId?: string;
  credentials: SiloCredentialProvider;
}): Promise<RelayEnvelope> {
  const unsigned: Omit<RelayEnvelope, "signature"> = {
    protocolVersion: "1.0", messageId: input.messageId, streamId: input.streamId, sequence: input.sequence,
    kind: input.kind, sentAt: input.sentAt, sender: structuredClone(input.sender), payload: structuredClone(input.payload),
    payloadDigest: relayPayloadDigest(input.payload), ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.causationId ? { causationId: input.causationId } : {}),
  };
  const signature = Buffer.from(await input.credentials.sign(input.sender.keyId, relaySigningBytes(unsigned))).toString("base64");
  const envelope = { ...unsigned, signature };
  validateRelayEnvelope(envelope);
  return envelope;
}

export function verifyRelayEnvelope(envelope: RelayEnvelope, publicKey: string): boolean {
  validateRelayEnvelope(envelope);
  const { signature, ...unsigned } = envelope;
  try { return cryptoVerify(null, relaySigningBytes(unsigned), publicKey, Buffer.from(signature, "base64")); }
  catch { return false; }
}
