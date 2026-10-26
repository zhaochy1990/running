import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextSnapshotSchema } from "../context.js";
import { buildPhaseEvidence, type PhasingActivityInput } from "./evidence.js";
import { AS_OF, ATHLETES, type AthleteName, applyInjuryScenario, buildAthleteEvidence, loadAthlete } from "./fixtureLoader.js";

test("fixture evidence: 月度窗口 = as_of 往前 6 个整月（2026-04 起），三运动员画像齐全", async () => {
  for (const name of Object.keys(ATHLETES) as AthleteName[]) {
    const evidence = await buildAthleteEvidence(name);
    assert.equal(evidence.as_of, AS_OF);
    assert.ok(evidence.monthly_focus.length >= 4, `${name} 月度画像行数 ${evidence.monthly_focus.length}`);
    assert.equal(evidence.monthly_focus[0]?.month, "2026-04");
    for (const m of evidence.monthly_focus) {
      assert.ok(m.km > 0);
      assert.ok(m.e_share_pct >= 0 && m.e_share_pct <= 100);
      assert.ok(m.weekly_km > 0);
    }
    assert.ok(evidence.recent_volume.avg_8wk_km > 0);
    assert.ok(evidence.recent_volume.recent_peak_week_km >= evidence.recent_volume.avg_4wk_km);
    assert.equal(evidence.target.target_time, ATHLETES[name].targetTime);
  }
});

test("fixture evidence: chaoyi 上场比赛 2026-10-24 → days_ago=2（I3 赛后先恢复场景）", async () => {
  const evidence = await buildAthleteEvidence("chaoyi");
  assert.equal(evidence.last_race?.date, "2026-10-24");
  assert.equal(evidence.last_race?.days_ago, 2);
});

test("fixture evidence: phase_credit 五字段齐全且非负", async () => {
  for (const name of Object.keys(ATHLETES) as AthleteName[]) {
    const credit = (await buildAthleteEvidence(name)).phase_credit;
    for (const value of Object.values(credit)) assert.ok(value >= 0);
  }
});

test("session_class 双值兼容：旧值 tempo/interval 归一为 quality、long 归一为 long_easy", async () => {
  const { snapshot } = await loadAthlete("pan");
  const legacy: PhasingActivityInput[] = [
    { date: "2026-09-01T01:00:00Z", name: "tempo", distanceM: 12000, strideSessionClass: "tempo" },
    { date: "2026-09-02T01:00:00Z", name: "interval", distanceM: 8000, strideSessionClass: "interval" },
    { date: "2026-09-03T01:00:00Z", name: "long", distanceM: 25000, strideSessionClass: "long" },
    { date: "2026-09-04T01:00:00Z", name: "easy", distanceM: 10000, strideSessionClass: "easy" },
  ];
  const evidence = buildPhaseEvidence(snapshot, legacy, { raceName: "测试", distance: "FM", targetTime: "3:00:00", weeklyRunDaysMax: 6 }, "2026-10-26");
  const september = evidence.monthly_focus.find((m) => m.month === "2026-09");
  assert.ok(september);
  // tempo+interval → quality×2；long → long_easy（E 类、最长长跑 25km）；easy → E 类
  assert.equal(september.quality_sessions, 2);
  assert.equal(september.long_quality_sessions, 0);
  assert.equal(september.longest_run_km, 25);
  assert.equal(september.e_share_pct, Math.round(((10 + 25) / 55) * 100));
});

test("窗口外月份不进画像（2026-03 活动被排除）", async () => {
  const { snapshot } = await loadAthlete("pan");
  const early: PhasingActivityInput[] = [
    { date: "2026-03-15T01:00:00Z", name: "out", distanceM: 30000, strideSessionClass: "long_easy" },
    { date: "2026-05-15T01:00:00Z", name: "in", distanceM: 10000, strideSessionClass: "easy" },
  ];
  const evidence = buildPhaseEvidence(snapshot, early, { raceName: "测试", distance: "FM", targetTime: "3:00:00", weeklyRunDaysMax: 6 }, "2026-10-26");
  assert.deepEqual(
    evidence.monthly_focus.map((m) => m.month),
    ["2026-05"],
  );
});

test("伤退推导：在册 active 伤（生产拼接串形态）→ injury_return 带伤前峰值；recovered 历史伤不触发", async () => {
  const { snapshot, activities } = await loadAthlete("chaoyi");
  assert.equal(snapshot.injuries.length, 0); // 基线 fixture 无伤
  const raw = JSON.parse(JSON.stringify(snapshot)) as unknown as {
    injuries: Array<{ body_area: string; status: string; occurred_on: string | null; source: string }>;
  };
  raw.injuries = [{ body_area: "膝髂胫束", status: "active; restriction=partial", occurred_on: "2026-09-01", source: "declared" }];
  const injured = ContextSnapshotSchema.parse(raw);
  const evidence = buildPhaseEvidence(injured, activities, { raceName: "无锡马拉松", distance: "FM", targetTime: "2:50:00", weeklyRunDaysMax: 6 }, AS_OF);
  assert.ok(evidence.injury_return);
  assert.ok(evidence.injury_return.pre_injury_peak_week_km > 0);
  assert.equal(evidence.injuries[0]?.status, "active; restriction=partial");
  // 已痊愈的历史伤（生产形态 "recovered; restriction=none"）不触发伤退帽
  const healedRaw = JSON.parse(JSON.stringify(snapshot)) as typeof raw;
  healedRaw.injuries = [{ body_area: "膝髂胫束", status: "recovered; restriction=none", occurred_on: "2026-01-01", source: "declared" }];
  const healed = buildPhaseEvidence(
    ContextSnapshotSchema.parse(healedRaw),
    activities,
    { raceName: "无锡马拉松", distance: "FM", targetTime: "2:50:00", weeklyRunDaysMax: 6 },
    AS_OF,
  );
  assert.equal(healed.injury_return, null);
});

test("常态无伤（fixture 原样）→ injury_return = null", async () => {
  const evidence = await buildAthleteEvidence("chaoyi");
  assert.equal(evidence.injury_return, null);
});

test("伤退场景变换（回放 helper）：injury_return 注入且近期量收缩", async () => {
  const base = await buildAthleteEvidence("chaoyi");
  const injured = applyInjuryScenario(base);
  assert.ok(injured.injury_return);
  assert.ok(injured.recent_volume.recent_peak_week_km < base.recent_volume.recent_peak_week_km);
});
