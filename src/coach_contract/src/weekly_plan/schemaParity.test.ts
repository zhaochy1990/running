import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WeeklyPlanSchema } from "./schema.js";

type PathPart = string | number;
type Patch =
  | { op: "set"; path: PathPart[]; value: unknown }
  | {
      op: "delete";
      path: PathPart[];
    };

const fixtures = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/weekly_plan_contract.json", import.meta.url), "utf8")) as {
  base: unknown;
  cases: Array<{ name: string; valid: boolean; patches: Patch[] }>;
};

function applyPatch(document: unknown, patch: Patch): void {
  let parent = document as Record<string, unknown> | unknown[];
  for (const part of patch.path.slice(0, -1)) {
    parent = parent[part as never] as Record<string, unknown> | unknown[];
  }
  const key = patch.path.at(-1);
  assert.notEqual(key, undefined);
  if (patch.op === "set") {
    parent[key as never] = patch.value as never;
  } else if (Array.isArray(parent) && typeof key === "number") {
    parent.splice(key, 1);
  } else {
    delete parent[key as never];
  }
}

test("canonical Weekly Plan schema matches the shared API contract fixtures", () => {
  for (const fixture of fixtures.cases) {
    const document = structuredClone(fixtures.base);
    for (const patch of fixture.patches as Patch[]) applyPatch(document, patch);
    assert.equal(WeeklyPlanSchema.safeParse(document).success, fixture.valid, fixture.name);
  }
});
