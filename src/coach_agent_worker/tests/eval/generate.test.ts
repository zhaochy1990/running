import assert from "node:assert/strict";
import test from "node:test";
import { type MasterPlanContextProvider, MasterPlanGraphRequest } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestRequest } from "@stride/coach-agent/test-fixtures";
import { generateArtifact } from "../../src/eval/generate.js";
import type { MasterPlanGraphShim } from "../../src/kernel/master/kernel.js";
import { createSnapshot } from "./fixtures.js";

const as_of = "2026-10-23T23:59:59+08:00";
const request = MasterPlanGraphRequest.parse({ ...createTestRequest(), requested_as_of: as_of });

function completedGraph(seen: unknown[]) {
  const outcome = createTestCompletedOutcomeV3({ totalWeeks: 2, weeklyDocs: 2 });
  return {
    async stream(input: { request: { requested_as_of?: string } }, options: { context: { userId: string } }) {
      seen.push({ requested_as_of: input.request.requested_as_of, userId: options.context.userId });
      return (async function* () {
        yield { initialize: {} };
        yield { finalize: { outcome } };
      })();
    },
  } as unknown as MasterPlanGraphShim;
}

test("a completed kernel run becomes one master_plan artifact holding the season plan and the first weekly batch", async () => {
  const seen: unknown[] = [];
  const result = await generateArtifact(
    { artifact_type: "master_plan", request, snapshot: createSnapshot(), as_of },
    { buildGraph: () => completedGraph(seen) },
    async () => {},
  );
  assert.equal(result.kind, "artifact");
  if (result.kind !== "artifact") return;
  const artifact = JSON.parse(result.content) as { type: string; plan: { total_weeks: number }; weekly_docs: unknown[] };
  assert.equal(result.artifact_type, "master_plan");
  assert.deepEqual(Object.keys(artifact).sort(), ["plan", "type", "weekly_docs"]);
  assert.equal(artifact.type, "master_plan");
  assert.equal(artifact.plan.total_weeks, 2);
  assert.equal(artifact.weekly_docs.length, 2);
  // 固定时点与脱敏跑者身份穿到被测版本的图入口。
  assert.deepEqual(seen, [{ requested_as_of: as_of, userId: "11111111-2222-4333-8333-333333333333" }]);
});

test("a snapshot or request that does not match the contract is reported as an incompatible execution input", async () => {
  const bad = await generateArtifact(
    { artifact_type: "master_plan", request, snapshot: { schema: "nope" }, as_of },
    {
      buildGraph: () => {
        throw new Error("must not build");
      },
    },
    async () => {},
  );
  assert.deepEqual(bad, { kind: "failed", error: { code: "execution_input_invalid", message: (bad as { error: { message: string } }).error.message } });
  const badRequest = await generateArtifact(
    { artifact_type: "master_plan", request: { request_id: "x" }, snapshot: createSnapshot(), as_of },
    {
      buildGraph: () => {
        throw new Error("must not build");
      },
    },
    async () => {},
  );
  assert.equal(badRequest.kind === "failed" ? badRequest.error.code : "", "execution_input_invalid");
});

test("kernel terminal decisions keep their stable error codes", async () => {
  const outcome = {
    decision: "goal_conflict",
    request_id: "request-342",
    generation_id: "g",
    artifact: { type: "goal_options", conflicts: ["too ambitious"], options: ["keep"] },
  };
  const graph = {
    async stream() {
      return (async function* () {
        yield { assess_goal: { outcome } };
      })();
    },
  } as unknown as MasterPlanGraphShim;
  const result = await generateArtifact(
    { artifact_type: "master_plan", request, snapshot: createSnapshot(), as_of },
    { buildGraph: () => graph },
    async () => {},
  );
  assert.equal(result.kind === "failed" ? result.error.code : "", "kernel_goal_conflict");
});

test("data the snapshot does not carry surfaces as the specific gap instead of a bare infrastructure failure", async () => {
  // 被测版本如果把取数窗口拉到截止日之后，图会收成 context_snapshot_unavailable；报告要带上具体缺口。
  const graph = {
    async stream() {
      return (async function* () {
        yield {
          initialize: {
            outcome: {
              decision: "infrastructure_failure",
              code: "context_snapshot_unavailable",
              request_id: "request-342",
              generation_id: "g",
              retryable: true,
            },
          },
        };
      })();
    },
  } as unknown as MasterPlanGraphShim;
  const result = await generateArtifact(
    { artifact_type: "master_plan", request, snapshot: createSnapshot(), as_of },
    {
      buildGraph: (contextProvider: MasterPlanContextProvider) => {
        // 模拟 kernel initialize 的取数：窗口越过截止日。
        void contextProvider.loadActivities("11111111-2222-4333-8333-333333333333", "2026-10-01", "2026-11-01").catch(() => undefined);
        return graph;
      },
    },
    async () => {},
  );
  assert.ok(result.kind === "failed");
  assert.equal(result.error.code, "infrastructure_failure");
  assert.match(result.error.message, /context_snapshot_unavailable.*getActivitiesByDateRange: .* is beyond the snapshot cutoff 2026-10-23/);
});
