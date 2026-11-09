import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanGraphRequest } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestRequest } from "@stride/coach-agent/test-fixtures";
import { asPermanent } from "../../src/job/errors.js";
import { runMasterKernel } from "../../src/kernel/master/kernel.js";

const runtime = { userId: "athlete-1", generationId: "plan-job-1" };
const request = MasterPlanGraphRequest.parse(createTestRequest());

interface GraphOverrides {
  snapshotThrows?: boolean;
  skeletonInvalid?: boolean;
}

/**
 * runner 的测试对象是「node 事件 → 进度/错误映射」，不是 kernel 本身。
 * 用假 stream 按新拓扑节点名吐事件 + 一份合法 v3 completed 产物。
 */
const NODE_SEQUENCE = ["initialize", "assess_goal", "l1_evidence", "l2_phasing", "l3_load", "l4_content", "daniels_audit", "snapshot_plan", "finalize"];

function buildGraph(overrides: GraphOverrides = {}) {
  const outcome = overrides.snapshotThrows
    ? { decision: "infrastructure_failure", request_id: "request-342", generation_id: "plan-job-1", code: "context_snapshot_unavailable", retryable: true }
    : overrides.skeletonInvalid
      ? {
          decision: "failed_quality_gate",
          request_id: "request-342",
          generation_id: "plan-job-1",
          artifact: { type: "quality_failure_report", unresolved_issues: ["load_gate:acwr"], attempt_history: [] },
        }
      : createTestCompletedOutcomeV3({ totalWeeks: 2 });
  return {
    async stream() {
      const nodes = overrides.snapshotThrows ? ["initialize"] : NODE_SEQUENCE;
      return (async function* () {
        for (const node of nodes) yield { [node]: {} };
        yield { finalize: { outcome } };
      })();
    },
  } as never;
}

test("completed kernel run streams monotonic node progress and returns the plan", async () => {
  const graph = buildGraph();
  const hbCalls: Array<{ stage: string; pct: number }> = [];
  const { plan, revision } = await runMasterKernel(graph, request, runtime, async (stage, pct) => {
    hbCalls.push({ stage, pct });
  });

  assert.equal(plan.status, "draft");
  assert.ok(revision >= 1);
  assert.ok(hbCalls.length >= 5, `expected node progress, got ${hbCalls.length}`);
  assert.equal(hbCalls[0]?.stage, "reading_history");
  for (let i = 1; i < hbCalls.length; i++) {
    assert.ok(hbCalls[i]!.pct >= hbCalls[i - 1]!.pct, `progress regressed at ${i}: ${JSON.stringify(hbCalls)}`);
  }
  const last = hbCalls[hbCalls.length - 1]!;
  assert.ok(last.pct >= 88 && last.stage === "outputting");
});

test("context snapshot failure surfaces as a retryable infra error", async () => {
  const graph = buildGraph({ snapshotThrows: true });
  await assert.rejects(
    runMasterKernel(graph, request, runtime, async () => {}),
    (error: unknown) => {
      assert.equal(asPermanent(error), null);
      return true;
    },
  );
});

test("quality-gate failure maps to a permanent stable error code", async () => {
  const graph = buildGraph({ skeletonInvalid: true });
  await assert.rejects(
    runMasterKernel(graph, request, runtime, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent, "expected a permanent error");
      assert.equal(permanent.code, "kernel_quality_gate_failed");
      return true;
    },
  );
});

test("kernel that ends without any outcome is a permanent error", async () => {
  const graph = {
    async stream() {
      return (async function* empty() {
        yield { some_unknown_node: { foo: 1 } };
      })();
    },
  };
  await assert.rejects(
    runMasterKernel(graph as never, request, runtime, async () => {}),
    (error: unknown) => {
      const permanent = asPermanent(error);
      assert.ok(permanent);
      assert.equal(permanent.code, "kernel_no_outcome");
      return true;
    },
  );
});
