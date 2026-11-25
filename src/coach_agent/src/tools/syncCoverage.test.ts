import assert from "node:assert/strict";
import test from "node:test";
import { createSyncCoverageTools } from "./syncCoverage.js";

const runtime = { context: { userId: "athlete-1", asof: "2026-11-17" } };

const SESSION_ROW = {
  session_id: "sess-1",
  provider: "garmin",
  binding_revision: 2,
  anchor_day: "2026-11-10",
  state: "running",
  shell_ready: 1,
  last_error: null,
  updated_at: "2026-11-17T08:00:00.000Z",
};

test("get_sync_coverage surfaces coverage, revision and explainable notes to the model", async () => {
  const tool = createSyncCoverageTools({
    async getSyncCoverage() {
      return {
        sessionId: SESSION_ROW.session_id,
        state: SESSION_ROW.state,
        provider: SESSION_ROW.provider,
        bindingRevision: 2,
        anchorDay: SESSION_ROW.anchor_day,
        error: null,
        stages: [
          {
            stage: "recent_raw",
            status: "completed",
            readiness: "ready_with_gaps",
            targetFrom: "2026-08-12",
            targetTo: "2026-11-10",
            scannedFrom: "2026-08-12",
            scannedTo: "2026-11-10",
            observedFrom: "2026-08-12",
            observedTo: "2026-11-10",
            gaps: [{ from: "2026-09-01", to: "2026-09-02", reason: "vendor unavailable" }],
            error: null,
          },
        ],
        readiness: {
          shellReady: true,
          recentData: "ready_with_gaps",
          recentAnalysis: "pending",
          extendedData: "not_started",
          historicalData: "not_started",
          historicalAnalysis: "not_started",
          auxiliary: "not_started",
        },
        recentAnalysisDetail: null,
        updatedAt: new Date("2026-11-17T08:00:00.000Z"),
      };
    },
  })[0]!;

  const result = (await tool.invoke({}, runtime)) as Record<string, unknown>;
  assert.equal(result.hasSession, true);
  assert.deepEqual((result.session as Record<string, unknown>).bindingRevision, 2);
  const explanation = result.explanation as { historicalAnalysisStatus: string; longTermComplete: boolean; notes: string[] };
  assert.equal(explanation.historicalAnalysisStatus, "pending_explicit_recompute");
  assert.equal(explanation.longTermComplete, false);
  assert.ok(explanation.notes.some((n) => n.includes("永久缺口")));
  assert.ok(explanation.notes.some((n) => n.includes("仍待历史补齐及重算")));
});

test("get_sync_coverage without a session explains legacy semantics instead of claiming missing data", async () => {
  const tool = createSyncCoverageTools({
    async getSyncCoverage() {
      return null;
    },
  })[0]!;
  const result = (await tool.invoke({}, runtime)) as Record<string, unknown>;
  assert.equal(result.hasSession, false);
  const note = result.note as string;
  assert.ok(note.includes("不代表数据缺失"));
  assert.ok(note.includes("不要凭 session 缺失断言"));
});
