import assert from "node:assert/strict";
import test from "node:test";
import { loadRoleCatalogue, renderClaude, renderCodex } from "../../src/roles/generate.ts";

test("Crew Manifest supplies unique display names without changing canonical role IDs", async () => {
  const catalogue = await loadRoleCatalogue();
  const expectedIds = [
    "architecture", "documentation", "guard", "implementation", "product",
    "qa", "release", "reliability", "reviewer", "scrum", "security",
    "specification", "ux",
  ];
  assert.deepEqual(catalogue.roles.map((role) => role.id), expectedIds);
  assert.equal(new Set(catalogue.roles.map((role) => role.displayName)).size, catalogue.roles.length);
  assert.ok(catalogue.roles.every((role) => role.displayName.trim().length > 0));
});

test("provider Crew definitions use Orbitkeep vocabulary and expose canonical IDs", async () => {
  const catalogue = await loadRoleCatalogue();
  for (const role of catalogue.roles) {
    for (const rendered of [renderClaude(role), renderCodex(role)]) {
      assert.match(rendered, new RegExp(role.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(rendered, /Mission Specialist/);
      assert.match(rendered, /Flight Director/);
      assert.match(rendered, /Mission Brief/);
      assert.match(rendered, /Mission Report/);
      assert.match(rendered, new RegExp(`canonical role ID: .*${role.id}`));
    }
  }
});
