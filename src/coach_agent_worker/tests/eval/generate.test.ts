import assert from "node:assert/strict";
import test from "node:test";
import { type MasterPlanContextProvider, MasterPlanGraphRequest } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestRequest } from "@stride/coach-agent/test-fixtures";
import { generateArtifact } from "../../src/eval/generate.js";
import type { MasterPlanGraphShim } from "../../src/kernel/master/kernel.js";
import { createSnapshot } from "./fixtures.js";

const as_of = "2026-10-23T23:59:59+08:00";
const buildModels = () => ({
  goalAssessmentModel: {
    invoke: async () => {
      throw new Error("not used by test graph");
    },
  },
  phasingModel: {
    invoke: async () => {
      throw new Error("master test must not call rolling models");
    },
  },
  contentModel: {
    invoke: async () => {
      throw new Error("master test must not call rolling models");
    },
  },
});
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
    { buildModels, buildGraph: () => completedGraph(seen) },
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
      buildModels,
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
      buildModels,
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
    { buildModels, buildGraph: () => graph },
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
      buildModels,
      buildGraph: (contextProvider: MasterPlanContextProvider) => {
        // 模拟 kernel initialize 的取数：窗口越过截止日。
        void contextProvider.loadActivities("11111111-2222-4333-8333-333333333333", "2026-10-01", "2026-11-01").catch(() => undefined);
        return graph;
      },
    },
    async () => {},
  );
  assert.ok(result.kind === "failed");
  assert.equal(result.error.code, "snapshot_not_covered");
  assert.match(result.error.message, /context_snapshot_unavailable.*getActivitiesByDateRange: .* is beyond the snapshot cutoff 2026-10-23/);
});

test("half-marathon new-season requests reach the target version unchanged and failures stay per-execution", async () => {
  const snapshot = createSnapshot();
  snapshot.event = "HM";
  snapshot.target_time = "1:20:00";
  const hmRequest = { ...request, goals: request.goals.map((goal) => ({ ...goal, distance: "HM", target_time: "1:20:00" })) };
  let captured: unknown;
  const graph = completedGraph([]);
  const result = await generateArtifact(
    { artifact_type: "master_plan", request: hmRequest, snapshot, as_of },
    {
      buildModels,
      buildGraph: () => ({
        ...graph,
        stream: async (input, options) => {
          captured = (input as { request: { goals: unknown } }).request.goals;
          return graph.stream(input, options);
        },
      }),
    },
    async () => {},
  );
  assert.equal(result.kind, "artifact");
  assert.deepEqual(captured, hmRequest.goals);
  const failure = await generateArtifact(
    { artifact_type: "master_plan", request: hmRequest, snapshot, as_of },
    {
      buildModels,
      buildGraph: () => {
        throw new Error("target version cannot generate half marathon");
      },
    },
    async () => {},
  );
  assert.ok(failure.kind === "failed");
  assert.match(failure.error.message, /cannot generate half marathon/);
  assert.equal(
    (
      await generateArtifact(
        { artifact_type: "master_plan", request, snapshot: createSnapshot(), as_of },
        { buildModels, buildGraph: () => completedGraph([]) },
        async () => {},
      )
    ).kind,
    "artifact",
  );
});

test("a master model fallback is reported as Generate failure instead of a successful model artifact", async () => {
  const outcome = createTestCompletedOutcomeV3({ totalWeeks: 2, weeklyDocs: 2 });
  (outcome.artifact.warnings as string[]).push("content_template_fallback");
  const graph = {
    stream: async () =>
      (async function* () {
        yield { finalize: { outcome } };
      })(),
  };
  const result = await generateArtifact(
    { artifact_type: "master_plan", request, snapshot: createSnapshot(), as_of },
    {
      buildGraph: () => graph,
      buildModels,
    },
    async () => {},
  );
  assert.ok(result.kind === "failed");
  assert.equal(result.error.code, "model_generation_failed");
  assert.match(result.error.message, /content: model output failed validation/);
});

test("master fallback reports the corresponding stage's retry violations, not a stale error from another stage", async () => {
  const outcome = createTestCompletedOutcomeV3({ totalWeeks: 2, weeklyDocs: 2 });
  (outcome.artifact.warnings as string[]).push("content_template_fallback");
  const result = await generateArtifact(
    { artifact_type: "master_plan", request, snapshot: createSnapshot(), as_of },
    {
      buildModels: () => ({ ...buildModels(), contentModel: { invoke: async () => ({ weeks: [] }) } }),
      buildGraph: (_context, models) => ({
        stream: async () => {
          await models.phasingModel.invoke({} as never).catch(() => {});
          await models.contentModel.invoke({} as never, { previous: null, violations: ["C1: invalid dose"] });
          return (async function* () {
            yield { finalize: { outcome } };
          })();
        },
      }),
    },
    async () => {},
  );
  assert.ok(result.kind === "failed");
  assert.match(result.error.message, /content: C1: invalid dose/);
  assert.doesNotMatch(result.error.message, /master test must not call rolling/);
});
