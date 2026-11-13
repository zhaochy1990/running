import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The CLI consumes a kernel outcome; replace its package boundary, never connect to a DB/model.
function runScript(decision: string, dump: string) {
  return spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", `
    import { mock } from 'node:test';
    import * as core from '@stride/coach-agent';
    import { createTestCompletedOutcomeV3 } from '@stride/coach-agent/test-fixtures';
    mock.module('@stride/coach-agent', { namedExports: {
      ...core,
      createMasterPlanLlmModels: () => ({}),
      createMasterPlanGraph: () => ({ invoke: async ({request}) => {
        if (request.requested_as_of !== '2026-11-13T04:00:00Z') throw Error('MP_AS_OF ignored');
        return { outcome: ${decision === "completed" ? "createTestCompletedOutcomeV3()" : `{decision: ${JSON.stringify(decision)}}`} };
      } }),
    }});
    mock.module('@stride/coach-agent-worker', { namedExports: {
      MySqlDataProvider: { create: () => ({ close: async () => console.log('store_closed') }) },
    }});
    await import('./dist/scripts/test_master_plan.js');
  `], {
    cwd: new URL("../..", import.meta.url),
    env: {
      PATH: process.env.PATH ?? "",
      STRIDE_COACH_GO_API_INTERNAL_TOKEN: "test-unused",
      STRIDE_COACH_LOG_LEVEL: "silent",
      MP_AS_OF: "2026-11-13T04:00:00Z",
      MP_DUMP: dump,
    },
    encoding: "utf8",
  });
}

test("real-test CLI exits nonzero for every non-completed decision and still closes its store", () => {
  const dir = mkdtempSync(join(tmpdir(), "master-plan-cli-"));
  try {
    for (const decision of ["failed_quality_gate", "needs_baseline", "blocked_for_safety", "infrastructure_failure", "review_completed"]) {
      const result = runScript(decision, join(dir, "artifact.json"));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, new RegExp(`decision=${decision}`));
      assert.match(result.stdout, /store_closed/);
      assert.throws(() => readFileSync(join(dir, "artifact.json")));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completed CLI retains successful output and artifact export", () => {
  const dir = mkdtempSync(join(tmpdir(), "master-plan-cli-"));
  try {
    const dump = join(dir, "artifact.json");
    const result = runScript("completed", dump);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /decision=completed.*artifact_revision=/s);
    assert.match(result.stdout, /audit=.*store_closed/s);
    assert.equal(JSON.parse(readFileSync(dump, "utf8")).type, "master_plan_draft");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
