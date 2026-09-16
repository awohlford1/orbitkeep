export interface GeneratedFlightPlan {
  approach: string[];
  acceptanceCriteria: string[];
}

function candidateJson(value: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value)?.[1]?.trim();
  if (fenced) return fenced;
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end > start ? value.slice(start, end + 1) : value.trim();
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw Object.assign(new Error(`Generated Flight Plan field '${name}' must be a non-empty array of strings.`), { code: "PROVIDER_PLAN_INVALID" });
  }
  return value.map((item) => (item as string).trim());
}

export function parseGeneratedFlightPlan(value: string): GeneratedFlightPlan {
  let parsed: unknown;
  try { parsed = JSON.parse(candidateJson(value)); }
  catch (error) { throw Object.assign(new Error(`Provider returned an invalid Flight Plan: ${error instanceof Error ? error.message : String(error)}`), { code: "PROVIDER_PLAN_INVALID" }); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Provider Flight Plan must be a JSON object."), { code: "PROVIDER_PLAN_INVALID" });
  }
  const plan = parsed as Record<string, unknown>;
  return { approach: stringList(plan.approach, "approach"), acceptanceCriteria: stringList(plan.acceptanceCriteria, "acceptanceCriteria") };
}

export function flightPlanPrompt(objective: string): string {
  return [
    "You are Orbitkeep's headless planning worker.",
    "Inspect the repository read-only as needed and create a concise Flight Plan for the objective below.",
    "Do not modify files, run workflow commands, claim ownership, approve anything, or begin implementation.",
    "Return only one JSON object with exactly these fields:",
    '{"approach":["ordered step"],"acceptanceCriteria":["verifiable outcome"]}',
    "",
    `Objective: ${objective}`,
  ].join("\n");
}

export function missionExecutionPrompt(input: { objective: string; approach: string[]; acceptanceCriteria: string[] }): string {
  return [
    "You are the headless Orbitkeep Flight Director for an already approved Mission.",
    "Follow the installed manager instructions and use Orbitkeep's canonical task, execution, result, and closure commands.",
    "Do not grant or impersonate Executive approval. Do not reveal ownership tokens or internal credentials.",
    "Keep all work within the approved Flight Plan and stop for a new Executive decision if a material change is needed.",
    "",
    `Objective: ${input.objective}`,
    "Approved approach:",
    ...input.approach.map((item, index) => `${index + 1}. ${item}`),
    "Acceptance criteria:",
    ...input.acceptanceCriteria.map((item) => `- ${item}`),
  ].join("\n");
}
