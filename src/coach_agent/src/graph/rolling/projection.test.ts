import assert from "node:assert/strict";
import { test } from "node:test";
import type { WeeklySeries } from "../master_plan/phasing/load/baseline.js";
import { createTestCompletedOutcomeV3 } from "../master_plan/testFixtures.js";
import { fromMasterArtifact, historyKmOf, type MasterPlanArtifact } from "./projection.js";

/**
 * 滚动投影纯函数单测（#858）：fromMasterArtifact 适配器（master completed 产物
 * → RollingMasterInput）+ historyKmOf（计划周 ↔ 实际周序列对齐）。runRollingProjection
 * 全链路需要 provider+LLM，归真实数据脚本（coach_agent_api/scripts/test_rolling.ts）验收。
 */

type RawArtifact = ReturnType<typeof createTestCompletedOutcomeV3>["artifact"];

/** 前 6 周带重点课（首批门控产物形态）的 10 周 completed 产物。 */
function artifactWithFirstBatch(): RawArtifact {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
  const keySession = {
    type: "long_run",
    distance_km: 20,
    duration_min: 100,
    intensity: "长跑：周末长跑",
    purpose: null,
    workout_structure: {
      schema: "run-workout/v1",
      name: "周末长跑",
      date: "2026-08-10",
      note: null,
      type: "LR",
      purpose: null,
      blocks: [
        {
          repeat: 1,
          steps: [
            {
              step_kind: "work",
              duration: { kind: "distance_m", value: 20000 },
              target: { kind: "pace_s_km", low: 330, high: 360 },
              note: null,
              hr_cap_bpm: null,
            },
          ],
        },
      ],
    },
  };
  for (const [index, week] of (artifact.plan.weeks as Array<{ key_sessions: unknown[] }>).entries()) {
    if (index < 6) week.key_sessions = [keySession];
  }
  return artifact;
}

test("fromMasterArtifact：政策包直通 + planStartMonday=快照 start_date + lastGeneratedWeek 取重点课最大周号", () => {
  const artifact = artifactWithFirstBatch();
  const master = fromMasterArtifact({ artifact: artifact as unknown as MasterPlanArtifact, availability: { weeklyRunDaysMax: 6 }, masterPlanId: "plan-1" });
  assert.equal(master.masterPlanId, "plan-1");
  assert.equal(master.planStartMonday, "2026-08-10");
  assert.equal(master.totalWeeks, 10);
  assert.deepEqual(master.race, { name: "西安马拉松", date: "2026-10-18", targetTime: "2:50:00", distance: "FM" });
  assert.deepEqual(master.availability, { weeklyRunDaysMax: 6 });
  assert.equal(master.lastGeneratedWeek, 6);
  // 政策包四段直通（引用同一对象，不复制重排）
  assert.equal(master.policy, artifact.policy);
  assert.equal(master.skeleton, artifact.skeleton);
  assert.equal(master.anchor, artifact.anchor);
});

test("fromMasterArtifact：无重点课时回退 min(6, totalWeeks)；显式覆盖优先", () => {
  const bare = createTestCompletedOutcomeV3({ totalWeeks: 10 }).artifact;
  assert.equal(
    fromMasterArtifact({ artifact: bare as unknown as MasterPlanArtifact, availability: { weeklyRunDaysMax: 6 }, masterPlanId: "p" }).lastGeneratedWeek,
    6,
  );
  const short = createTestCompletedOutcomeV3({ totalWeeks: 2 }).artifact;
  assert.equal(
    fromMasterArtifact({ artifact: short as unknown as MasterPlanArtifact, availability: { weeklyRunDaysMax: 6 }, masterPlanId: "p" }).lastGeneratedWeek,
    2,
  );
  const overridden = fromMasterArtifact({
    artifact: artifactWithFirstBatch() as unknown as MasterPlanArtifact,
    availability: { weeklyRunDaysMax: 6 },
    masterPlanId: "p",
    lastGeneratedWeek: 8,
  });
  assert.equal(overridden.lastGeneratedWeek, 8);
});

// ── historyKmOf（#858 自适应链路的 L3 historyKm 来源）────────────────────────

/** 2026-10-05（周一）起的 series：W1=66、W2 缺席（gap=0）、W3=72；更早/更晚的周与计划周无对上。 */
function seriesFixture(): WeeklySeries {
  const week = (weekStart: string, km: number) => ({ weekStart, km, race: false, postRace: false, gap: km < 15, taperLike: false });
  return {
    weeks: [week("2026-09-21", 50), week("2026-09-28", 58), week("2026-10-05", 66), week("2026-10-19", 72), week("2026-10-26", 40)],
    races: [],
    asOf: "2026-11-02",
  };
}

test("historyKmOf：计划周对上取实际 km，gap 周对不上取 0（没跑就是没跑）", () => {
  // planStart=2026-10-05：W1=66；W2（2026-10-12）series 无此周 → 0；W3（10-19）=72
  assert.deepEqual(historyKmOf(seriesFixture(), "2026-10-05", 3), [66, 0, 72]);
  // throughWeek=0（currentWeek=1，尚无完整周）→ 空数组（展开器退回 master 行为）
  assert.deepEqual(historyKmOf(seriesFixture(), "2026-10-05", 0), []);
  // 计划周落在 series 窗口之前（28 周回看外）→ 0
  assert.deepEqual(historyKmOf(seriesFixture(), "2026-08-31", 2), [0, 0]);
});
