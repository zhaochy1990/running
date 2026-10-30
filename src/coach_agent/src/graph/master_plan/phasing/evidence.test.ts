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

test("fixture evidence: chaoyi race_history 换显式信号并集后，最近比赛=2026-04-12 全马（35km 渐进训练课不再误入，devops#790）", async () => {
  const evidence = await buildAthleteEvidence("chaoyi");
  assert.equal(evidence.last_race?.date, "2026-04-12");
  assert.equal(evidence.last_race?.distance_km, 42.7);
  assert.equal(evidence.last_race?.days_ago, 197);
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

test("三运动员 current_capability：陈旧比赛锚（>8 周，#837）与校准融合、confidence 降 medium、等效齐全、pace_zones 五带直读", async () => {
  // 比赛锚均距 as_of 超 8 周（chaoyi 3/22、ding 3/22、pan 4/12）：融合 max(校准, 比赛×0.98)
  // ——chaoyi 校准胜（52.9>50.1），ding/pan 打折比赛胜；hm_fm 保持档名但降 medium
  const expected = {
    chaoyi: { vdot: 52.9, source: "calibration", sourceDate: "2026-10-20", improvementPct: 6.4, fmEquiv: 10903 },
    dingchentao: { vdot: 55.9, source: "recent_race_hm_fm", sourceDate: "2026-03-22", improvementPct: 3.8, fmEquiv: 10418 },
    pan: { vdot: 41.4, source: "recent_race_hm_fm", sourceDate: "2026-04-12", improvementPct: 1.5, fmEquiv: 13402 },
  } as const;
  for (const [name, exp] of Object.entries(expected)) {
    const evidence = await buildAthleteEvidence(name as AthleteName);
    const cap = evidence.current_capability;
    assert.equal(cap.source, exp.source, name);
    assert.equal(cap.confidence, "medium", name);
    assert.equal(cap.source_date, exp.sourceDate, name);
    assert.ok(Math.abs((cap.vdot ?? 0) - exp.vdot) <= 0.05, `${name} vdot ${cap.vdot}`);
    assert.ok(cap.equivalents, name);
    assert.deepEqual(Object.keys(cap.equivalents).sort(), ["10K", "5K", "FM", "HM"], name);
    assert.ok(Math.abs(cap.equivalents.FM - exp.fmEquiv) <= 1, `${name} FM 等效 ${cap.equivalents.FM}`);
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

test("improvement_pct 保守档（规则 4，新鲜比赛）：8 周内比赛与校准同在 → 锚取保守者（min）而非 current_capability.vdot", async () => {
  // ding 3/22 比赛已陈旧（融合语义），注入 8 周内新鲜比赛还原规则 4 原路径：
  // 校准 VDOT≈54.8 < 新鲜比赛锚 → improvement 按保守者（校准档）算
  const { snapshot, activities } = await fixtureSnapshot("dingchentao", (raw) => {
    raw.race_history = [{ date: "2026-10-11", distance_km: 21.3, duration_min: 82, avg_pace_s_km: 231, avg_hr: 168, max_hr: 182, feel: null }];
  });
  const evidence = buildPhaseEvidence(snapshot, activities, { raceName: "无锡马拉松", distance: "FM", targetTime: "2:47:00", weeklyRunDaysMax: 7 }, AS_OF);
  const cap = evidence.current_capability;
  assert.equal(cap.source, "recent_race_hm_fm");
  assert.equal(cap.confidence, "high"); // 新鲜比赛保持 high（#837 只降陈旧锚）
  const targetSec = 2 * 3600 + 47 * 60;
  const impliedByCapability = Math.round((((cap.equivalents?.FM ?? 0) - targetSec) / (cap.equivalents?.FM ?? 1)) * 1000) / 10;
  assert.notEqual(impliedByCapability, evidence.target.improvement_pct);
});

test("陈旧比赛锚（>8 周，#837）：无校准时比赛照用但降 medium；有校准取 max(校准, 比赛×0.98)——进步被低估方向翻转", async () => {
  const goal = { raceName: "无锡马拉松", distance: "FM" as const, targetTime: "2:50:00", weeklyRunDaysMax: 6 };
  // 陈旧 HM 比赛（VDOT≈51.1）无校准：照用原值、降 medium
  const noCalib = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2026-03-22", distance_km: 21.3, duration_min: 90.7, avg_pace_s_km: 254.87, avg_hr: 165, max_hr: 180, feel: null }];
    raw.running_calibration = null;
  });
  const staleEvidence = buildPhaseEvidence(noCalib.snapshot, noCalib.activities, goal, AS_OF);
  assert.equal(staleEvidence.current_capability.source, "recent_race_hm_fm");
  assert.equal(staleEvidence.current_capability.confidence, "medium"); // 陈旧降级（原 high）
  assert.ok(Math.abs((staleEvidence.current_capability.vdot ?? 0) - 51.1) <= 0.05); // 无校准不打折
  // 同一比赛 + 校准 52.9：融合取校准（旧比赛不再把锚拖到 51.1——#837 主诉场景）
  const withCalib = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2026-03-22", distance_km: 21.3, duration_min: 90.7, avg_pace_s_km: 254.87, avg_hr: 165, max_hr: 180, feel: null }];
  });
  const fused = buildPhaseEvidence(withCalib.snapshot, withCalib.activities, goal, AS_OF).current_capability;
  assert.equal(fused.source, "calibration");
  assert.ok(Math.abs((fused.vdot ?? 0) - 52.9) <= 0.05);
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

test("阶梯第 4 档（#837）：无比赛无校准 + 近 8 周质量课配速改善 → training_inference（medium）；配速未改善或无素材 → none", async () => {
  const goal = { raceName: "无锡马拉松", distance: "FM" as const, targetTime: "2:50:00", weeklyRunDaysMax: 6 };
  // chaoyi fixture 近 8 周有足量质量课且配速在改善 → 第 4 档接住（不再直接落 none）
  const noAnchors = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [];
    raw.running_calibration = null;
  });
  const inferred = buildPhaseEvidence(noAnchors.snapshot, noAnchors.activities, goal, AS_OF).current_capability;
  assert.equal(inferred.source, "training_inference");
  assert.equal(inferred.confidence, "medium");
  assert.ok(inferred.vdot != null && inferred.vdot > 40 && inferred.vdot < 70, `推断 VDOT 合理区间，实际 ${inferred.vdot}`);
  assert.ok(inferred.source_date != null);
  // 质量课配速未改善（整窗统一配速）→ 推断不成立落 none
  const flat = {
    snapshot: noAnchors.snapshot,
    activities: noAnchors.activities.map((a, i) => ({
      date: a.date,
      name: a.name,
      distanceM: a.distanceM,
      strideSessionClass: a.strideSessionClass,
      durationS: a.distanceM != null ? a.distanceM * 0.27 : null,
    })),
  };
  assert.equal(buildPhaseEvidence(flat.snapshot, flat.activities, goal, AS_OF).current_capability.source, "none");
  // 质量课素材不可得（活动行无时长）→ 阶梯彻底落空 none
  const noMaterial = {
    snapshot: noAnchors.snapshot,
    activities: noAnchors.activities.map((a) => ({ date: a.date, name: a.name, distanceM: a.distanceM, strideSessionClass: a.strideSessionClass })),
  };
  const evidence = buildPhaseEvidence(noMaterial.snapshot, noMaterial.activities, goal, AS_OF);
  assert.equal(evidence.current_capability.source, "none");
  assert.equal(evidence.current_capability.confidence, "low");
  assert.equal(evidence.current_capability.vdot, null);
  assert.equal(evidence.current_capability.equivalents, null);
  assert.equal(evidence.current_capability.source_date, null);
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

test("脏数据防御：荒谬 VDOT 行（如 duration_min 单位错误）被丢弃不炸 evidence；荒谬校准阈值同样落空", async () => {
  const goal = { raceName: "无锡马拉松", distance: "FM" as const, targetTime: "2:50:00", weeklyRunDaysMax: 6 };
  // 42.2km 记 3.2「分钟」（小时当分钟）→ 全力过滤只滤慢不滤快 → 荒谬 VDOT 须由合理性区间拦截
  const dirtyRace = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2026-09-01", distance_km: 42.2, duration_min: 3.2, avg_pace_s_km: 4.5, avg_hr: 160, max_hr: 175, feel: null }];
  });
  const raceEvidence = buildPhaseEvidence(dirtyRace.snapshot, dirtyRace.activities, goal, AS_OF);
  assert.equal(raceEvidence.current_capability.source, "calibration");
  // 校准阈值速度单位错误（40 m/s）→ 校准档落空；叠加无比赛 → 第 4 档推断接住（#837）
  const dirtyCalib = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [];
    (raw.running_calibration as { threshold_speed_mps?: number }).threshold_speed_mps = 40;
  });
  const dirtyEvidence = buildPhaseEvidence(dirtyCalib.snapshot, dirtyCalib.activities, goal, AS_OF);
  assert.equal(dirtyEvidence.current_capability.source, "training_inference");
  assert.ok(dirtyEvidence.current_capability.vdot != null && dirtyEvidence.current_capability.vdot < 70, "荒谬校准不污染推断档");
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
  assert.equal(out.target.improvement_pct, 6.4);
  assert.equal(out.current_capability.source, "calibration");
  assert.equal(out.peak_fm_pb?.achieved_at, "2025-03-30");
});

test("last_race ≥10km 下限：最近比赛是 5K 时不触发 I3（跳过取更早的 HM；只有 5K 则为 null）（devops#790）", async () => {
  const mkRace = (date: string, distanceKm: number) => ({
    date,
    distance_km: distanceKm,
    duration_min: 60,
    avg_pace_s_km: null,
    avg_hr: null,
    max_hr: null,
    feel: null,
  });
  const goal = { raceName: "测试", distance: "FM" as const, targetTime: "3:40:00", weeklyRunDaysMax: 5 };
  const withHistory = async (rows: unknown[]) => {
    const { snapshot, activities } = await fixtureSnapshot("pan", (raw) => {
      raw.race_history = rows;
    });
    return buildPhaseEvidence(snapshot, activities, goal, AS_OF);
  };

  // 最近 5K（2026-10-20）+ 更早 HM（2026-10-01）→ last_race 取 HM，不被 5K 触发
  const fiveKThenHm = await withHistory([mkRace("2026-10-20", 5), mkRace("2026-10-01", 21.1)]);
  assert.equal(fiveKThenHm.last_race?.date, "2026-10-01");
  assert.equal(fiveKThenHm.last_race?.distance_km, 21.1);

  // 只有 5K → last_race 为 null（无长距离比赛，I3 不触发）
  const fiveKOnly = await withHistory([mkRace("2026-10-20", 5)]);
  assert.equal(fiveKOnly.last_race, null);
});

test("陈旧短距离比赛锚（#837）：打折赛值胜出融合时保持 recent_race_short 且等效含折扣，校准胜出时折扣不跟（锚不再是短距离源）", async () => {
  const goal = { raceName: "无锡马拉松", distance: "FM" as const, targetTime: "2:50:00", weeklyRunDaysMax: 6 };
  // 陈旧 10K 强表现（VDOT≈60，×0.98≈58.8 仍胜 chaoyi 校准 52.9）→ race 档胜出
  const raceWins = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2026-03-01", distance_km: 10, duration_min: 34, avg_pace_s_km: 204, avg_hr: 175, max_hr: 188, feel: null }];
  });
  const winsCap = buildPhaseEvidence(raceWins.snapshot, raceWins.activities, goal, AS_OF).current_capability;
  assert.equal(winsCap.source, "recent_race_short");
  assert.equal(winsCap.confidence, "medium"); // 陈旧降级
  const winsEq = winsCap.equivalents!;
  const plainFm = raceTimeSecFromVdot(RACE_DISTANCES_M.FM, winsCap.vdot ?? 0);
  assert.ok(winsEq.FM >= plainFm * 1.02 && winsEq.FM <= plainFm * 1.04, `融合胜出时长距等效仍含 ×1.03（${winsEq.FM} vs ${plainFm}）`);
  // 陈旧 10K 弱表现（×0.98 后低于校准 52.9）→ 校准胜出，等效不打短距离折扣
  const calibWins = await fixtureSnapshot("chaoyi", (raw) => {
    raw.race_history = [{ date: "2026-03-01", distance_km: 10, duration_min: 40, avg_pace_s_km: 240, avg_hr: 168, max_hr: 180, feel: null }];
  });
  const calibCap = buildPhaseEvidence(calibWins.snapshot, calibWins.activities, goal, AS_OF).current_capability;
  assert.equal(calibCap.source, "calibration");
  const calibPlain = raceTimeSecFromVdot(RACE_DISTANCES_M.FM, calibCap.vdot ?? 0);
  assert.ok(Math.abs(calibCap.equivalents!.FM - calibPlain) <= 8, `校准锚等效无折扣（${calibCap.equivalents!.FM} vs ${calibPlain}，容差吸收 vdot 1 位小数取整≈FM 5s）`);
});
