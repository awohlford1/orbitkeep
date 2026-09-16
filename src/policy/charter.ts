import { verify as cryptoVerify } from "node:crypto";
import { canonicalJson } from "../config/index.ts";
import type { FrameworkConfiguration } from "../contracts/configuration.ts";
import type { ResourceBudget } from "../commands/types.ts";

export interface CharterRules {
  providers?: { allowed?: string[]; denied?: string[] };
  models?: { allowedByRole: Record<string, string[]> };
  resources?: { maxInputTokens?: number; maxOutputTokens?: number; maxTotalTokens?: number; maxCostMicros?: number; maxElapsedMs?: number; maxRuns?: number; maxConcurrentOperations?: number };
  filesystem?: { read: string[]; write: string[] };
  network?: { allowedHosts: string[] };
  secrets?: { allowedReferences: string[] };
  crew?: { allowedRoles: string[] };
  gates?: { required: string[] };
  clearances?: { requiredActions: string[] };
  retention?: { maxRawResponsesDays?: number; maxClosedAssignmentsDays?: number };
  redaction?: { required: boolean };
}

export interface CharterDocument { schemaVersion: "1.0"; charterId: string; revision: number; issuedAt: string; expiresAt?: string; rules: CharterRules }
export interface SignedCharter { keyId: string; charter: CharterDocument; signature: string }
export interface CharterSet { local: CharterDocument; central?: CharterDocument }
export interface CharterRequest {
  action: string; provider?: string; model?: string; role?: string; readPaths?: string[]; writePaths?: string[];
  networkHosts?: string[]; secretReferences?: string[]; budget?: ResourceBudget; concurrentOperations?: number;
  satisfiedGates?: string[]; clearanceGranted?: boolean; rawResponsesDays?: number; closedAssignmentsDays?: number; redactionEnabled?: boolean;
}
export interface CharterDecision { allowed: boolean; code: "CHARTER_ALLOWED" | "CHARTER_DENIED"; violations: string[]; evaluatedCharters: Array<{ charterId: string; revision: number }> }

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const id = /^chr-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const domains = ["providers", "models", "resources", "filesystem", "network", "secrets", "crew", "gates", "clearances", "retention", "redaction"];
const exact = (value: object, allowed: string[], label: string) => { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new Error(`CHARTER_INVALID: unknown ${label} properties ${unknown.join(", ")}`); };
const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()) || new Set(value).size !== value.length) throw new Error(`CHARTER_INVALID: ${label} must contain unique non-empty strings`);
  return [...value];
};
const integer = (value: unknown, label: string) => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`CHARTER_INVALID: ${label} must be a nonnegative safe integer`); };

export function validateCharter(input: unknown): CharterDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("CHARTER_INVALID: expected an object");
  const root = input as Record<string, unknown>; exact(root, ["schemaVersion", "charterId", "revision", "issuedAt", "expiresAt", "rules"], "root");
  if (root.schemaVersion !== "1.0") throw new Error("CHARTER_SCHEMA_UNSUPPORTED");
  if (typeof root.charterId !== "string" || !id.test(root.charterId)) throw new Error("CHARTER_INVALID: charterId must use the chr- prefix");
  if (!Number.isSafeInteger(root.revision) || (root.revision as number) < 1) throw new Error("CHARTER_INVALID: revision must be positive");
  if (typeof root.issuedAt !== "string" || !utc.test(root.issuedAt) || (root.expiresAt !== undefined && (typeof root.expiresAt !== "string" || !utc.test(root.expiresAt)))) throw new Error("CHARTER_INVALID: timestamps must be UTC");
  if (!root.rules || typeof root.rules !== "object" || Array.isArray(root.rules)) throw new Error("CHARTER_INVALID: rules are required");
  const rules = structuredClone(root.rules) as CharterRules; exact(rules, domains, "rules");
  for (const [name, rule] of Object.entries(rules)) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new Error(`CHARTER_INVALID: ${name} must be an object`);
  }
  if (rules.providers) { exact(rules.providers, ["allowed", "denied"], "providers"); if (rules.providers.allowed) strings(rules.providers.allowed, "providers.allowed"); if (rules.providers.denied) strings(rules.providers.denied, "providers.denied"); if (!rules.providers.allowed && !rules.providers.denied) throw new Error("CHARTER_INVALID: providers requires allowed or denied"); }
  if (rules.models) { exact(rules.models, ["allowedByRole"], "models"); if (!rules.models.allowedByRole || typeof rules.models.allowedByRole !== "object" || Array.isArray(rules.models.allowedByRole)) throw new Error("CHARTER_INVALID: models.allowedByRole"); for (const [role, allowed] of Object.entries(rules.models.allowedByRole)) strings(allowed, `models.allowedByRole.${role}`); }
  if (rules.resources) { const keys = ["maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxCostMicros", "maxElapsedMs", "maxRuns", "maxConcurrentOperations"]; exact(rules.resources, keys, "resources"); for (const [key, value] of Object.entries(rules.resources)) integer(value, `resources.${key}`); }
  if (rules.filesystem) { exact(rules.filesystem, ["read", "write"], "filesystem"); strings(rules.filesystem.read, "filesystem.read"); strings(rules.filesystem.write, "filesystem.write"); }
  if (rules.network) { exact(rules.network, ["allowedHosts"], "network"); strings(rules.network.allowedHosts, "network.allowedHosts"); }
  if (rules.secrets) { exact(rules.secrets, ["allowedReferences"], "secrets"); strings(rules.secrets.allowedReferences, "secrets.allowedReferences"); }
  if (rules.crew) { exact(rules.crew, ["allowedRoles"], "crew"); strings(rules.crew.allowedRoles, "crew.allowedRoles"); }
  if (rules.gates) { exact(rules.gates, ["required"], "gates"); strings(rules.gates.required, "gates.required"); }
  if (rules.clearances) { exact(rules.clearances, ["requiredActions"], "clearances"); strings(rules.clearances.requiredActions, "clearances.requiredActions"); }
  if (rules.retention) { exact(rules.retention, ["maxRawResponsesDays", "maxClosedAssignmentsDays"], "retention"); for (const [key, value] of Object.entries(rules.retention)) integer(value, `retention.${key}`); }
  if (rules.redaction) { exact(rules.redaction, ["required"], "redaction"); if (typeof rules.redaction.required !== "boolean") throw new Error("CHARTER_INVALID: redaction.required must be boolean"); }
  return structuredClone(root) as unknown as CharterDocument;
}

function matches(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*");
    return new RegExp(`^${escaped}$`).test(value);
  });
}

function violations(charter: CharterDocument, request: CharterRequest): string[] {
  const rules = charter.rules, found: string[] = [];
  if (request.provider && rules.providers?.denied?.some((pattern) => matches(request.provider!, [pattern]))) found.push("provider_denied");
  if (request.provider && rules.providers?.allowed && !matches(request.provider, rules.providers.allowed)) found.push("provider_not_allowed");
  if (request.role && rules.crew && !rules.crew.allowedRoles.includes(request.role)) found.push("crew_role_not_allowed");
  if (request.model && request.role && rules.models) { const allowed = rules.models.allowedByRole[request.role]; if (allowed?.length && !allowed.includes(`${request.provider}:${request.model}`)) found.push("model_not_allowed"); }
  for (const [kind, paths] of [["read", request.readPaths], ["write", request.writePaths]] as const) if (paths && rules.filesystem) for (const path of paths) if (!matches(path, rules.filesystem[kind])) found.push(`filesystem_${kind}_not_allowed:${path}`);
  for (const host of request.networkHosts ?? []) if (rules.network && !matches(host, rules.network.allowedHosts)) found.push(`network_host_not_allowed:${host}`);
  for (const secret of request.secretReferences ?? []) if (rules.secrets && !rules.secrets.allowedReferences.includes(secret)) found.push(`secret_not_allowed:${secret}`);
  const budgetMap: Array<[keyof NonNullable<CharterRules["resources"]>, keyof ResourceBudget]> = [["maxInputTokens", "inputTokens"], ["maxOutputTokens", "outputTokens"], ["maxTotalTokens", "totalTokens"], ["maxCostMicros", "costMicros"], ["maxElapsedMs", "elapsedMs"], ["maxRuns", "maxRuns"]];
  for (const [limit, value] of budgetMap) if (request.budget?.[value] !== undefined && rules.resources?.[limit] !== undefined && request.budget[value]! > rules.resources[limit]!) found.push(`resource_limit_exceeded:${String(value)}`);
  if (request.concurrentOperations !== undefined && rules.resources?.maxConcurrentOperations !== undefined && request.concurrentOperations > rules.resources.maxConcurrentOperations) found.push("resource_limit_exceeded:maxConcurrentOperations");
  for (const gate of rules.gates?.required ?? []) if (!(request.satisfiedGates ?? []).includes(gate)) found.push(`gate_required:${gate}`);
  if (rules.clearances?.requiredActions.includes(request.action) && request.clearanceGranted !== true) found.push(`clearance_required:${request.action}`);
  if (request.rawResponsesDays !== undefined && rules.retention?.maxRawResponsesDays !== undefined && request.rawResponsesDays > rules.retention.maxRawResponsesDays) found.push("retention_exceeded:rawResponsesDays");
  if (request.closedAssignmentsDays !== undefined && rules.retention?.maxClosedAssignmentsDays !== undefined && request.closedAssignmentsDays > rules.retention.maxClosedAssignmentsDays) found.push("retention_exceeded:closedAssignmentsDays");
  if (rules.redaction?.required && request.redactionEnabled !== true) found.push("redaction_required");
  return found;
}

export function evaluateCharters(set: CharterSet, request: CharterRequest, now = new Date()): CharterDecision {
  const charters = [set.central, set.local].filter((item): item is CharterDocument => Boolean(item)).map(validateCharter);
  const expired = charters.filter((charter) => charter.expiresAt && new Date(charter.expiresAt).getTime() <= now.getTime()).map((charter) => `charter_expired:${charter.charterId}`);
  const denied = charters.flatMap((charter) => violations(charter, request).map((item) => `${charter.charterId}:${item}`));
  const all = [...expired, ...denied];
  return { allowed: all.length === 0, code: all.length ? "CHARTER_DENIED" : "CHARTER_ALLOWED", violations: all, evaluatedCharters: charters.map(({ charterId, revision }) => ({ charterId, revision })) };
}

export function verifySignedCharter(signed: SignedCharter, trustedKeys: Record<string, string>, now = new Date()): CharterDocument {
  const charter = validateCharter(signed.charter), publicKey = trustedKeys[signed.keyId];
  if (!publicKey) throw new Error("CHARTER_UNTRUSTED_KEY");
  let valid = false; try { valid = cryptoVerify(null, Buffer.from(canonicalJson(charter)), publicKey, Buffer.from(signed.signature, "base64")); } catch { valid = false; }
  if (!valid) throw new Error("CHARTER_SIGNATURE_INVALID");
  if (new Date(charter.issuedAt).getTime() > now.getTime()) throw new Error("CHARTER_NOT_YET_VALID");
  if (charter.expiresAt && new Date(charter.expiresAt).getTime() <= now.getTime()) throw new Error("CHARTER_EXPIRED");
  return charter;
}

export function acceptCentralCharter(input: { signed: SignedCharter; trustedKeys: Record<string, string>; current?: CharterDocument; now?: Date }): CharterDocument {
  const candidate = verifySignedCharter(input.signed, input.trustedKeys, input.now);
  if (!input.current) return candidate;
  const current = validateCharter(input.current);
  if (candidate.charterId !== current.charterId) throw new Error("CHARTER_ID_MISMATCH");
  if (candidate.revision < current.revision) throw new Error("CHARTER_REVISION_ROLLBACK");
  if (candidate.revision === current.revision) {
    if (canonicalJson(candidate) !== canonicalJson(current)) throw new Error("CHARTER_REVISION_CONFLICT");
    return current;
  }
  return candidate;
}

export function charterFromConfiguration(config: FrameworkConfiguration, issuedAt = new Date(0).toISOString()): CharterDocument {
  return { schemaVersion: "1.0", charterId: "chr-effective-configuration", revision: 1, issuedAt, rules: {
    providers: { denied: Object.entries(config.providers).filter(([, policy]) => !policy.enabled).map(([provider]) => provider) },
    models: { allowedByRole: Object.fromEntries(Object.entries(config.models.roles).map(([role, policy]) => [role, [...policy.allowed]])) },
    crew: { allowedRoles: [...config.roles.enabled] }, retention: { maxRawResponsesDays: config.retention.rawResponsesDays, maxClosedAssignmentsDays: config.retention.closedAssignmentsDays },
    redaction: { required: config.security.secretRedaction },
  } };
}
