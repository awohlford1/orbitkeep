import type { JsonSchema } from "../validation/schema/index.ts";

const text = (pattern?: string): JsonSchema => ({ type: "string", minLength: 1, ...(pattern ? { pattern } : {}) });
export const relayEnvelopeSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-workflow.dev/schemas/1.0/relay-envelope.schema.json",
  type: "object",
  required: ["protocolVersion", "messageId", "streamId", "sequence", "kind", "sentAt", "sender", "payload", "payloadDigest", "signature"],
  properties: {
    protocolVersion: { const: "1.0" }, messageId: text("^[A-Za-z][A-Za-z0-9._:-]*$"), streamId: text("^[A-Za-z][A-Za-z0-9._:-]*$"),
    sequence: { type: "integer", minimum: 1 }, kind: { enum: ["command", "event", "status", "handover"] }, sentAt: { type: "string", format: "date-time" },
    sender: { type: "object", required: ["siloId", "siloInstanceId", "keyId"], properties: { siloId: text("^[A-Za-z][A-Za-z0-9._:-]*$"), siloInstanceId: text("^[A-Za-z][A-Za-z0-9._:-]*$"), keyId: text("^[A-Za-z][A-Za-z0-9._:-]*$") }, additionalProperties: false },
    payload: {}, payloadDigest: text("^sha256:[A-Fa-f0-9]{64}$"), correlationId: text("^[A-Za-z][A-Za-z0-9._:-]*$"), causationId: text("^[A-Za-z][A-Za-z0-9._:-]*$"), signature: text("^[A-Za-z0-9+/]+={0,2}$"),
  },
  additionalProperties: false,
};
