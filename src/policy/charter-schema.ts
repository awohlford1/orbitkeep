import type { JsonSchema } from "../validation/schema/index.ts";

const textArray: JsonSchema = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };
const limit: JsonSchema = { type: "integer", minimum: 0 };
const strict = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

export const charterSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://agent-workflow.dev/schemas/1.0/charter.schema.json",
  ...strict({
    schemaVersion: { const: "1.0" }, charterId: { type: "string", pattern: "^chr-[A-Za-z0-9][A-Za-z0-9._-]*$" }, revision: { type: "integer", minimum: 1 },
    issuedAt: { type: "string", format: "date-time" }, expiresAt: { type: "string", format: "date-time" },
    rules: strict({
      providers: strict({ allowed: textArray, denied: textArray }),
      models: strict({ allowedByRole: { type: "object", additionalProperties: textArray } }, ["allowedByRole"]),
      resources: strict({ maxInputTokens: limit, maxOutputTokens: limit, maxTotalTokens: limit, maxCostMicros: limit, maxElapsedMs: limit, maxRuns: limit, maxConcurrentOperations: limit }),
      filesystem: strict({ read: textArray, write: textArray }, ["read", "write"]), network: strict({ allowedHosts: textArray }, ["allowedHosts"]),
      secrets: strict({ allowedReferences: textArray }, ["allowedReferences"]), crew: strict({ allowedRoles: textArray }, ["allowedRoles"]),
      gates: strict({ required: textArray }, ["required"]), clearances: strict({ requiredActions: textArray }, ["requiredActions"]),
      retention: strict({ maxRawResponsesDays: limit, maxClosedAssignmentsDays: limit }), redaction: strict({ required: { type: "boolean" } }, ["required"]),
    }),
  }, ["schemaVersion", "charterId", "revision", "issuedAt", "rules"]),
};
