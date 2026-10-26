import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextSnapshotSchema } from "../context.js";
import { buildIntentPayload } from "./doctrine.js";
import { buildPhaseEvidence, type PhasingActivityInput } from "./evidence.js";
import { AS_OF, ATHLETES, type AthleteName, applyInjuryScenario, buildAthleteEvidence, loadAthlete } from "./fixtureLoader.js";
import { RACE_DISTANCES_M, raceTimeSecFromVdot } from "./vdot.js";

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

// ── current_capability / improvement_pct（devops#789，期望值取自实现实测冻结） ──

const fixtureSnapshot = async (name: AthleteName, mutate: (raw: Record<string, unknown>) => void) => {
  const { snapshot, activities } = await loadAthlete(name);
  const raw = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  mutate(raw);
  return { snapshot: ContextSnapshotSchema.parse(raw), activities };
};

test("三运动员 current_capability：阶梯第 1 档（HM+ 全力最佳）、四距离等效齐全、pace_zones 五带直读", async () => {
  const expected = {
    chaoyi: { vdot: 51.3, sourceDate: "2026-03-15", improvementPct: 8.8, fmEquiv: 11187 },
    dingchentao: { vdot: 57, sourceDate: "2026-03-22", improvementPct: 4.6, fmEquiv: 10241 },
    pan: { vdot: 42.2, sourceDate: "2026-04-12", improvementPct: 2.6, fmEquiv: 13180 },
  } as const;
  for (const [name, exp] of Object.entries(expected)) {
    const evidence = await buildAthleteEvidence(name as AthleteName);
    const cap = evidence.current_capability;
    assert.equal(cap.source, "recent_race_hm_fm", name);
    assert.equal(cap.confidence, "high", name);
    assert.equal(cap.source_date, exp.sourceDate, name);
    assert.ok(Math.abs((cap.vdot ?? 0) - exp.vdot) <= 0.05, `${name} vdot ${cap.vdot}`);
    assert.deepEqual(Object.keys(cap.equivalents ?? {}).sort(), ["10K", "5K", "FM", "HM"], name);
    assert.ok(Math.abs((cap.equivalents?.FM ?? 0) - exp.fmEquiv) <= 1, `${name} FM 等效 ${cap.equivalents?.FM}`);
    assert.equal(evidence.target.improvement_pct, exp.improvementPct, name);
    // 配速带（校准快照直读）：五带齐全，双边界带 lo<hi
    const zones = cap.pace_zones;
    assert.ok(zones, name);
    for (const [zone, pair] of Object.entries(zones)) {
      assert.ok(pair !== null, `${name}.${zone}`);
      if (pair[0] != null && pair[1] != null) assert.ok(pair[0] < pair[1], `${name}.${zone} ${pair}`);
    }
  }
});

test("improvement_pct 保守档（规则 4）：ding 校准 VDOT 低于比赛锚 → 锚取保守者而非 current_capability.vdot", async () => {
  const evidence = await buildAthleteEvidence("dingchentao");
  const targetSec = 2 * 3600 + 47 * 60;
  const impliedByCapability =
    Math.round((((evidence.current_capability.equivalents?.FM ?? 0) - targetSec) / (evidence.current_capability.equivalents?.FM ?? 1)) * 1000) / 10;
  // 校准阈值 4.28 m/s → VDOT≈55.3 < 比赛锚 57 → improvement 按 55.3 档算（4.6），而非 57 档的 2.2
  assert.equal(evidence.target.improvement_pct, 4.6);
  assert.notEqual(impliedByCapability, evidence.target.improvement_pct);
});

test("peak_fm_pb：FM PB 直读（辅助字段，不作可行性锚）", async () => {
  const evidence = await buildAthleteEvidence("chaoyi");
  assert.deepEqual(evidence.peak_fm_pb, { time_sec: 10631.4, achieved_at: "2025-03-30" });
});

test("阶梯第 3 档：无近期比赛 + 有校准 → source=calibration、vdot=52.9、improvement 按校准档", async () => {
  const { snapshot, activities } = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [];
  });
  const evidence = buildPhaseEvidence(snapshot, activities, { raceName: "无锡马拉松", distance: "FM", targetTime: "2:50:00", weeklyRunDaysMax: 6 }, AS_OF);
  const cap = evidence.current_capability;
  assert.equal(cap.source, "calibration");
  assert.equal(cap.confidence, "medium");
  assert.equal(cap.source_date, "2026-10-20");
  assert.equal(cap.vdot, 52.9); // 阈值 4.1337 m/s = 4:02/km → %max(60) 换算（#789 设计校准例）
  assert.ok(cap.pace_zones != null);
  assert.equal(evidence.target.improvement_pct, 6.4);
});

test("阶梯落空：无近期比赛且无校准 → source=none、全 null、improvement_pct=null", async () => {
  const { snapshot, activities } = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [];
    raw.running_calibration = null;
  });
  const evidence = buildPhaseEvidence(snapshot, activities, { raceName: "无锡马拉松", distance: "FM", targetTime: "2:50:00", weeklyRunDaysMax: 6 }, AS_OF);
  assert.equal(evidence.current_capability.source, "none");
  assert.equal(evidence.current_capability.confidence, "low");
  assert.equal(evidence.current_capability.vdot, null);
  assert.equal(evidence.current_capability.equivalents, null);
  assert.equal(evidence.current_capability.source_date, null);
  assert.equal(evidence.current_capability.pace_zones, null);
  assert.equal(evidence.target.improvement_pct, null);
});

test("全力识别：均配慢于校准阈值×1.15 的比赛不参与取锚（落校准档）；窗口外（>365 天）同理", async () => {
  const goal = { raceName: "无锡马拉松", distance: "FM" as const, targetTime: "2:50:00", weeklyRunDaysMax: 6 };
  const slow = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2026-09-01", distance_km: 30, duration_min: 155, avg_pace_s_km: 310, avg_hr: 150, max_hr: 165, feel: null }];
  });
  assert.equal(buildPhaseEvidence(slow.snapshot, slow.activities, goal, AS_OF).current_capability.source, "calibration");
  const stale = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2025-06-01", distance_km: 42.2, duration_min: 185, avg_pace_s_km: 263, avg_hr: 165, max_hr: 178, feel: null }];
  });
  assert.equal(buildPhaseEvidence(stale.snapshot, stale.activities, goal, AS_OF).current_capability.source, "calibration");
});

test("阶梯第 2 档：仅 10K 近期比赛 → recent_race_short（medium），更长距离等效含 ×1.03 保守折扣", async () => {
  const { snapshot, activities } = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2026-09-01", distance_km: 10, duration_min: 38, avg_pace_s_km: 228, avg_hr: 170, max_hr: 182, feel: null }];
  });
  const evidence = buildPhaseEvidence(snapshot, activities, { raceName: "无锡马拉松", distance: "FM", targetTime: "2:50:00", weeklyRunDaysMax: 6 }, AS_OF);
  const cap = evidence.current_capability;
  assert.equal(cap.source, "recent_race_short");
  assert.equal(cap.confidence, "medium");
  assert.ok(cap.vdot != null && cap.vdot > 0);
  const eq = cap.equivalents ?? { "5K": 0, "10K": 0, HM: 0, FM: 0 };
  // 源距离及更短不打折（这里 10K 38min 自身即锚），更长距离 ≈×1.03（±1% 容差吸收 vdot 取整）
  assert.ok(Math.abs(eq["10K"] - raceTimeSecFromVdot(RACE_DISTANCES_M["10K"], cap.vdot ?? 0)) <= 3);
  for (const key of ["HM", "FM"] as const) {
    const plain = raceTimeSecFromVdot(RACE_DISTANCES_M[key], cap.vdot ?? 0);
    assert.ok(eq[key] >= plain * 1.02 && eq[key] <= plain * 1.04, `${key} ${eq[key]} vs ${plain}`);
  }
});

test("buildIntentPayload 透出 improvement_pct 与 current_capability（判断层消费）", async () => {
  const evidence = await buildAthleteEvidence("chaoyi");
  const payload = buildIntentPayload({ evidence, runwayWeeks: 20, raceDate: "2027-03-01" });
  const out = payload.evidence as typeof evidence;
  assert.equal(out.target.improvement_pct, 8.8);
  assert.equal(out.current_capability.source, "recent_race_hm_fm");
  assert.equal(out.peak_fm_pb?.achieved_at, "2025-03-30");
});
