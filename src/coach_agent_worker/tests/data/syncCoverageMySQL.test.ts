import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { MySqlDataProvider } from "../../src/data/mysqlDataProvider.js";

/** devops#1013：getSyncCoverage 只读 onboarding sync 四张表，无 session 返回 null。 */

function fakePool(resultByTable: Record<string, unknown[]>, calls: Array<{ sql: string; values: unknown[] }>) {
  return {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      for (const table of Object.keys(resultByTable)) {
        if (sql.includes(`FROM ${table}`)) return [resultByTable[table] ?? []];
      }
      return [[]];
    },
  } as never;
}

test("getSyncCoverage returns null without a session (legacy user, not missing data)", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const provider = new MySqlDataProvider(fakePool({ onboarding_sync_sessions: [] }, calls));
  assert.equal(await provider.getSyncCoverage("athlete-1"), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /state <> 'superseded'/);
  assert.match(calls[0]?.sql ?? "", /ORDER BY created_at DESC/);
  assert.deepEqual(calls[0]?.values, ["athlete-1"]);
});

test("getSyncCoverage reads Go-written rows and derives the API-view semantics", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const provider = new MySqlDataProvider(
    fakePool(
      {
        onboarding_sync_sessions: [
          {
            session_id: "sess-go-1",
            provider: "coros",
            binding_revision: 4,
            anchor_day: "2026-11-10",
            state: "running",
            shell_ready: 1,
            last_error: null,
            updated_at: new Date("2026-11-17T08:00:00Z"),
          },
        ],
        onboarding_sync_stage_coverage: [
          {
            stage: "recent_analysis",
            status: "completed_with_gaps",
            target_from: "2026-08-12",
            target_to: "2026-11-10",
            scanned_from: null,
            scanned_to: null,
            observed_from: null,
            observed_to: null,
            gaps_json: null,
            last_error: null,
          },
          {
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
          },
          {
            stage: "historical_raw",
            status: "running",
            target_from: "2000-01-01",
            target_to: "2026-08-11",
            scanned_from: null,
            scanned_to: null,
            observed_from: "2026-07-01",
            observed_to: "2026-08-11",
            gaps_json: '[{"from":"2026-05-01","to":"2026-05-02","reason":"vendor deleted"}]',
            last_error: null,
          },
        ],
        onboarding_sync_dispatches: [{ stage: "recent_analysis", status: "dispatched" }],
        onboarding_recent_analysis: [
          {
            as_of_day: "2026-11-16",
            status: "partial",
            stale: 1,
            domains_json: '{"calibration":{"status":"ready"},"load":{"status":"unavailable","reason":"missing historical calibration"}}',
            coverage_from: "2026-08-12",
            coverage_to: "2026-11-10",
            input_fingerprint: "digest-9",
            computed_at: new Date("2026-11-16T23:00:00Z"),
          },
        ],
      },
      calls,
    ),
  );

  const coverage = await provider.getSyncCoverage("athlete-1");
  assert.ok(coverage);
  assert.equal(coverage.sessionId, "sess-go-1");
  assert.equal(coverage.provider, "coros");
  assert.equal(coverage.bindingRevision, 4);
  assert.equal(coverage.readiness.recentData, "ready");
  assert.equal(coverage.readiness.historicalData, "running");
  assert.equal(coverage.readiness.recentAnalysis, "partial");
  assert.equal(coverage.recentAnalysisDetail?.refreshing, true);
  assert.equal(coverage.recentAnalysisDetail?.asOfDay, "2026-11-16");
  assert.equal(coverage.recentAnalysisDetail?.inputFingerprint, "digest-9");
  assert.deepEqual(coverage.stages.find((stage) => stage.stage === "historical_raw")?.gaps, [
    { from: "2026-05-01", to: "2026-05-02", reason: "vendor deleted" },
  ]);
  // 其余三张表都按 session 过滤。
  const sessionFiltered = calls.filter((call) => call.values[0] === "sess-go-1");
  assert.equal(sessionFiltered.length, 3);
});

test("getSyncCoverage against real Go-seeded MySQL when the shared fixture is provided", {
  skip: !process.env.STRIDE_1013_ISOLATED_MYSQL_URL || !process.env.STRIDE_1013_FIXTURE,
}, async () => {
  const url = process.env.STRIDE_1013_ISOLATED_MYSQL_URL;
  const fixturePath = process.env.STRIDE_1013_FIXTURE;
  if (!url || !fixturePath) throw new Error("missing isolated fixture");
  const { readFile } = await import("node:fs/promises");
  const expected = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || !/^\/[\w-]+_test$/.test(parsed.pathname)) {
    throw new Error("STRIDE_1013_ISOLATED_MYSQL_URL must point to an isolated local test database");
  }
  const pool = mysql.createPool({ uri: url, timezone: "Z", connectionLimit: 2 });
  try {
    const provider = new MySqlDataProvider(pool);
    const coverage = await provider.getSyncCoverage(String(expected.user_id));
    assert.ok(coverage, "session seeded by the Go fixture must be readable");
    assert.equal(coverage.sessionId, expected.session_id);
    assert.equal(coverage.readiness.recentData, String(expected.recent_data));
    assert.equal(coverage.readiness.recentAnalysis, String(expected.recent_analysis));
    assert.equal(coverage.readiness.historicalData, String(expected.historical_data));
    assert.equal(coverage.recentAnalysisDetail?.asOfDay ?? null, expected.as_of_day ?? null);
    assert.equal(coverage.recentAnalysisDetail?.stale, expected.analysis_stale === true);
    assert.equal(coverage.recentAnalysisDetail?.status ?? null, (expected.analysis_status as string) ?? null);
    const byStage: Record<string, string> = Object.fromEntries(coverage.stages.map((stage) => [stage.stage, stage.readiness]));
    assert.deepEqual(byStage, expected.stage_readiness);
  } finally {
    await pool.end();
  }
});
