import assert from "node:assert/strict";
import test from "node:test";
import { flightPlanPrompt, missionExecutionPrompt, parseGeneratedFlightPlan } from "../../src/control/flight-plan.ts";

test("generated Flight Plans accept plain or fenced JSON and validate required lists", () => {
  const expected = { approach: ["Inspect"], acceptanceCriteria: ["Report produced"] };
  assert.deepEqual(parseGeneratedFlightPlan(JSON.stringify(expected)), expected);
  assert.deepEqual(parseGeneratedFlightPlan(`Here is the plan:\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``), expected);
  assert.throws(() => parseGeneratedFlightPlan('{"approach":[],"acceptanceCriteria":[]}'), (error: unknown) => (error as { code?: string }).code === "PROVIDER_PLAN_INVALID");
});

test("headless prompts separate planning from approved execution", () => {
  assert.match(flightPlanPrompt("Ship it"), /Do not modify files/);
  assert.match(flightPlanPrompt("Ship it"), /Return only one JSON object/);
  const execution = missionExecutionPrompt({ objective: "Ship it", approach: ["Build"], acceptanceCriteria: ["Tests pass"] });
  assert.match(execution, /already approved Orbitkeep Mission/);
  assert.match(execution, /Do not grant or impersonate Executive approval/);
  assert.match(execution, /parent Orbitkeep control process already owns/);
  assert.match(execution, /Do not invoke Orbitkeep workflow or lifecycle commands/);
});
