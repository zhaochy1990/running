import assert from "node:assert/strict";
import test from "node:test";
import type { SyncCoverage } from "./dataProvider.js";
import { deriveSyncCoverage, explainSyncCoverage, type SyncSessionRow, type SyncStageCoverageRow } from "./syncCoverage.js";

const TODAY = "2026-11-17";

function session(overrides: Partial<SyncSessionRow> = {}): SyncSessionRow {
  return {
    session_id: "sess-1",
    provider: "garmin",
    binding_revision: 3,
    anchor_day: "2026-11-10",
    state: "running",
    shell_ready: 1,
    last_error: null,
    updated_at: "2026-11-17T08:00:00.000Z",
    ...overrides,
  };
}

function coverageRow(overrides: Partial<SyncStageCoverageRow> = {}): SyncStageCoverageRow {
  return {
    stage: "recent_raw",
    status: "completed",
    target_from: "2026-08-12",
    target_to: "2026-11-10",
    scanned_from: "2026-08-12",
    scanned_to: "2026-11-10",
    observed_from: "2026-08-12",
    observed_to: "2026-11-10",
    gaps_json: null,
    last_error: null,
    ...overrides,
  };
}

test("recent raw ready only when the observed window truly covers the target", () => {
  const ready = deriveSyncCoverage(session(), [coverageRow()], [], null);
  assert.equal(ready.readiness.recentData, "ready");

  const narrowed = deriveSyncCoverage(session(), [coverageRow({ observed_from: "2026-09-01" })], [], null);
  assert.equal(narrowed.readiness.recentData, "running", "observation short of target is not ready");

  const noObservation = deriveSyncCoverage(session(), [coverageRow({ observed_from: null, observed_to: null })], [], null);
  assert.equal(noObservation.readiness.recentData, "running", "done scan without observation is not ready");
});

test("recorded gaps downgrade to ready_with_gaps and stay visible", () => {
  const cov = deriveSyncCoverage(session(), [coverageRow({ gaps_json: '[{"from":"2026-09-01","to":"2026-09-03","reason":"vendor_deleted"}]' })], [], null);
  assert.equal(cov.readiness.recentData, "ready_with_gaps");
  assert.deepEqual(cov.stages[0]?.gaps, [{ from: "2026-09-01", to: "2026-09-03", reason: "vendor_deleted" }]);
});

test("failed dispatch overrides the stage status (mirrors Go view; analysis level fails explicitly)", () => {
  // Go View 语义：dispatch failed 把 StageView.Status 改写为 failed；raw 阶段的
  // readiness 仍取 coverage 行（durable 真值，失败由 sweep 重试），而 recent_analysis
  // 的 readiness 会显式 failed——这里逐条镜像。
  const cov = deriveSyncCoverage(session(), [coverageRow()], [{ stage: "recent_raw", status: "failed" }], null);
  assert.equal(cov.stages[0]?.status, "failed");
  assert.equal(cov.readiness.recentData, "ready");

  const analysis = deriveSyncCoverage(
    session(),
    [coverageRow({ stage: "recent_analysis", status: "running", observed_from: null, observed_to: null })],
    [{ stage: "recent_analysis", status: "failed" }],
    null,
  );
  assert.equal(analysis.readiness.recentAnalysis, "failed");
});

test("analysis refresh in flight keeps the published level and flags refreshing", () => {
  const analysis = {
    as_of_day: "2026-11-16",
    status: "ready",
    stale: 1,
    domains_json: '{"calibration":{"status":"ready"}}',
    coverage_from: "2026-08-12",
    coverage_to: "2026-11-10",
    input_fingerprint: "abc123",
    computed_at: "2026-11-16T09:00:00.000Z",
  };
  const cov = deriveSyncCoverage(
    session(),
    [coverageRow({ stage: "recent_analysis", status: "running", observed_from: null, observed_to: null })],
    [{ stage: "recent_analysis", status: "dispatched" }],
    analysis,
  );
  assert.equal(cov.readiness.recentAnalysis, "ready", "a refresh does not retract the published result");
  assert.equal(cov.recentAnalysisDetail?.refreshing, true);
  assert.equal(cov.recentAnalysisDetail?.asOfDay, "2026-11-16");
  assert.equal(cov.recentAnalysisDetail?.inputFingerprint, "abc123");
});

test("completed analysis stage without a published row is explicitly pending", () => {
  const cov = deriveSyncCoverage(session(), [coverageRow({ stage: "recent_analysis", status: "completed", observed_from: null, observed_to: null })], [], null);
  assert.equal(cov.readiness.recentAnalysis, "pending");
});

test("waiting_legacy pins recent data to pending", () => {
  const cov = deriveSyncCoverage(session({ state: "waiting_legacy" }), [coverageRow()], [], null);
  assert.equal(cov.readiness.recentData, "pending");
});

test("explanation: long-term conclusions stay bounded until history and explicit recompute land", () => {
  const cov = deriveSyncCoverage(
    session(),
    [coverageRow(), coverageRow({ stage: "extended_raw", status: "running", observed_from: "2026-08-12", observed_to: "2026-10-01" })],
    [],
    null,
  );
  const explanation = explainSyncCoverage(cov, TODAY);
  assert.equal(explanation.historicalAnalysisStatus, "pending_explicit_recompute");
  assert.equal(explanation.longTermComplete, false);
  assert.ok(explanation.notes.some((n) => n.includes("后台补齐")));
  assert.ok(explanation.notes.some((n) => n.includes("仍待历史补齐及重算")));
  assert.ok(
    explanation.notes.some((n) => n.includes("已获得证据窗口")),
    "recent evidence window is stated",
  );
});

test("explanation: stale cross-day analysis says its as-of instead of today", () => {
  const cov = deriveSyncCoverage(
    session(),
    [coverageRow(), coverageRow({ stage: "recent_analysis", status: "completed", observed_from: null, observed_to: null })],
    [],
    {
      as_of_day: "2026-11-15",
      status: "ready",
      stale: 0,
      domains_json: null,
      coverage_from: "2026-08-12",
      coverage_to: "2026-11-10",
      input_fingerprint: "f1",
      computed_at: "2026-11-15T23:00:00.000Z",
    },
  );
  const explanation = explainSyncCoverage(cov, TODAY);
  assert.equal(explanation.recentAnalysis.stale, true);
  assert.ok(
    explanation.notes.some((n) => n.includes("早于今天")),
    "cross-day staleness is explained",
  );
});

test("explanation: background failure gets a concrete reason, never an endless organizing note", () => {
  const cov = deriveSyncCoverage(
    session(),
    [coverageRow(), coverageRow({ stage: "historical_raw", status: "failed", observed_from: null, observed_to: null, last_error: "coros 429 rate limited" })],
    [{ stage: "historical_raw", status: "failed" }],
    null,
  );
  const explanation = explainSyncCoverage(cov, TODAY);
  assert.equal(explanation.historicalDataReadiness, "failed");
  assert.ok(explanation.notes.some((n) => n.includes("历史补齐失败") && n.includes("coros 429 rate limited")));
  assert.ok(explanation.notes.every((n) => !n.includes("整理中")));
});

test("explanation: partial analysis lists the unavailable domains", () => {
  const cov = deriveSyncCoverage(
    session(),
    [coverageRow(), coverageRow({ stage: "recent_analysis", status: "completed", observed_from: null, observed_to: null })],
    [],
    {
      as_of_day: TODAY,
      status: "partial",
      stale: 0,
      domains_json: '{"calibration":{"status":"ready"},"load":{"status":"unavailable","reason":"missing historical calibration"}}',
      coverage_from: "2026-08-12",
      coverage_to: "2026-11-10",
      input_fingerprint: "f2",
      computed_at: `${TODAY}T06:00:00.000Z`,
    },
  );
  const explanation = explainSyncCoverage(cov, TODAY);
  assert.deepEqual(explanation.recentAnalysis.unavailableDomains, [{ domain: "load", reason: "missing historical calibration" }]);
  assert.ok(explanation.notes.some((n) => n.includes("部分可用")));
});

test("long term completes only when history and its analysis are both ready", () => {
  const base: SyncCoverage = deriveSyncCoverage(
    session({ state: "completed" }),
    [coverageRow(), coverageRow({ stage: "extended_raw", status: "completed" }), coverageRow({ stage: "historical_raw", status: "completed" })],
    [],
    null,
  );
  assert.equal(explainSyncCoverage(base, TODAY).longTermComplete, false, "historical analysis is still pending_explicit_recompute");
});

test("published history repairs a stale diagnosis while keeping actual gaps and the original cutoff", () => {
  const analysisDay = "2026-11-16";
  const cov = deriveSyncCoverage(
    session({ state: "completed" }),
    [coverageRow({ stage: "recent_analysis" }), coverageRow({ stage: "historical_raw" }), coverageRow({ stage: "auxiliary" })],
    [],
    {
      as_of_day: analysisDay,
      status: "unavailable",
      stale: 1,
      domains_json:
        '{"load":{"status":"unavailable","reason":"historical_calibration_missing"},"zones":{"status":"unavailable","reason":"historical_calibration_missing"},"ability":{"status":"unavailable","reason":"vendor_gap"}}',
      coverage_from: "2026-08-12",
      coverage_to: analysisDay,
      input_fingerprint: "original",
      computed_at: `${analysisDay}T13:00:00Z`,
    },
    { readiness: "ready_with_gaps", recentEvidence: { activities: 4, loads: 4, zones: 2, ability: false } },
  );
  assert.equal(cov.readiness.historicalAnalysis, "ready_with_gaps");
  assert.equal(cov.readiness.recentAnalysis, "partial");
  assert.equal(cov.recentAnalysisDetail?.asOfDay, analysisDay);
  assert.deepEqual(cov.recentAnalysisDetail?.domains, {
    load: { status: "ready" },
    zones: { status: "partial", reason: "historical_recompute_coverage_gap" },
    ability: { status: "unavailable", reason: "vendor_gap" },
  });
  assert.equal(explainSyncCoverage(cov, TODAY).longTermComplete, false);
});
