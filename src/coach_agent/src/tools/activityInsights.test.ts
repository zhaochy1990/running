import assert from "node:assert/strict";
import test from "node:test";
import type { Activity, DailyTrainingLoad, DataProvider, RunningCalibration, WeeklyPlanDocument } from "../data/dataProvider.js";
import { createActivityInsightTools } from "./activityInsights.js";

const userId = "athlete-1";
const asof = "2026-10-09";

function makeActivity(over: Partial<Activity> = {}): Activity {
  return {
    userId,
    labelId: "L1",
    name: "Evening Run",
    sportName: null,
    // 上海时间 2026-10-09 18:30 —— 上海日历日必须还是 2026-10-09。
    date: new Date("2026-10-09T10:30:00Z"),
    distanceM: 12000,
    durationS: 3600,
    avgPaceSKm: 300,
    bestKmPace: 280,
    maxPace: 250,
    avgHr: 147,
    maxHr: 165,
    avgCadence: 178,
    maxCadence: 184,
    avgPower: 240,
    maxPower: 300,
    avgStepLenCm: 112,
    ascentM: 0,
    descentM: 0,
    strideDose: 92.5,
    strideSessionClass: "easy",
    temperature: 26,
    humidity: 70,
    feelsLike: 32,
    windSpeed: 8,
    sportNote: null,
    sport: "run_outdoor",
    feel: null,
    verticalOscillationMm: null,
    groundContactTimeMs: null,
    verticalRatioPct: null,
    pauses: null,
    provider: "coros",
    laps: [],
    ...over,
  };
}

function lap(index: number, distanceM: number, pace: number, hr: number | null) {
  return {
    lapIndex: index,
    lapType: "type2",
    distanceM,
    durationS: Math.round((distanceM / 1000) * pace),
    avgPace: pace,
    adjustedPace: null,
    avgHr: hr,
    maxHr: hr === null ? null : hr + 5,
    avgCadence: 178,
    avgPower: 240,
    ascentM: 0,
    descentM: 0,
    exerciseType: null,
    exerciseNameKey: null,
    mode: null,
  };
}

interface ProviderOver {
  activity?: Activity | null;
  summaries?: Activity[];
  loads?: DailyTrainingLoad[];
  calibration?: RunningCalibration | null;
  plan?: WeeklyPlanDocument | null;
}

function makeProvider(over: ProviderOver = {}): DataProvider {
  return {
    async getActivityDetail(_uid: string, labelId: string) {
      return over.activity === null || over.activity === undefined ? null : { ...over.activity, userId, labelId };
    },
    async getActivitySummariesByDateRange() {
      return over.summaries ?? [];
    },
    async getDailyTrainingLoadByDateRange() {
      return over.loads ?? [];
    },
    async getLatestRunningCalibration() {
      return over.calibration ?? null;
    },
    async getWeeklyPlan() {
      return over.plan ?? null;
    },
  } as unknown as DataProvider;
}

/** 近 4 周同 class 基线：HR = 0.25×pace + 75（280→145, 300→150, 320→155）。 */
function baselineSummaries(): Activity[] {
  return [
    makeActivity({ labelId: "B1", date: new Date("2026-10-02T04:00:00Z"), avgPaceSKm: 280, avgHr: 145 }),
    makeActivity({ labelId: "B2", date: new Date("2026-09-25T04:00:00Z"), avgPaceSKm: 300, avgHr: 150 }),
    makeActivity({ labelId: "B3", date: new Date("2026-09-18T04:00:00Z"), avgPaceSKm: 320, avgHr: 155 }),
    // 不同 class，不进基线；但在本周内，是质量课 → 计入 week_quality_count。
    makeActivity({
      labelId: "Q1",
      date: new Date("2026-10-07T03:00:00Z"),
      strideSessionClass: "interval",
      name: "间歇 5x1000",
      avgPaceSKm: 260,
      avgHr: 162,
      distanceM: 5000,
    }),
  ];
}

const CALIBRATION: RunningCalibration = {
  asOfDate: "2026-10-01",
  thresholdHr: 168,
  thresholdSpeedMps: 3.9,
  rhrBaseline: 48,
  thresholdHrConfidence: "high",
  thresholdSpeedConfidence: "medium",
  heartRateZones: [],
  paceZones: [],
};

const PLAN: WeeklyPlanDocument = {
  sessions: [
    { kind: "run", date: "2026-10-09", summary: "节奏跑 10km", total_distance_m: 10000 },
    { kind: "strength", date: "2026-10-09", summary: "核心 30min" },
    { kind: "run", date: "2026-10-08", summary: "easy 8km", total_distance_m: 8000 },
  ],
};

const LOADS: DailyTrainingLoad[] = [
  { date: "2026-10-02", trainingDose: 80, acuteLoad: 70, chronicLoad: 65, form: -5, loadRatio: 1.08, coverageStatus: "full" },
  { date: "2026-10-09", trainingDose: 95, acuteLoad: 74, chronicLoad: 66, form: -4.5, loadRatio: 1.15, coverageStatus: "full" },
];

async function invoke(provider: DataProvider, labelId = "L1") {
  const [tool] = createActivityInsightTools(provider);
  assert.ok(tool);
  assert.equal(tool.name, "get_activity_insights");
  return tool.invoke({ labelId }, { context: { userId, asof } });
}

test("insights: baseline regression, thermal drift, plan deviation, load position", async () => {
  const activity = makeActivity({
    laps: [lap(1, 3000, 300, 140), lap(2, 3000, 300, 140), lap(3, 3000, 300, 148), lap(4, 3000, 300, 148)],
  });
  const result = await invoke(makeProvider({ activity, summaries: baselineSummaries(), loads: LOADS, calibration: CALIBRATION, plan: PLAN }));

  assert.equal(result.available, true);
  if (!result.available) return;
  assert.equal(result.session.day, "2026-10-09");
  assert.equal(result.session.is_quality, false);
  assert.deepEqual(result.session.weather, { feels_like_c: 32, humidity_pct: 70 });

  // 基线 math：HR = 0.25×pace + 75，300 s/km 处期望 150，实际 147 → delta −3。
  assert.deepEqual(result.efficiency_delta, { n: 3, method: "regression", expected_hr_bpm: 150, delta_bpm: -3 });

  // 前后半程同心率 +8，配速不变（无斜率可校正），体感 32°C → 热漂移。
  assert.deepEqual(result.hr_drift, {
    laps_used: 4,
    first_half_hr: 140,
    second_half_hr: 148,
    hr_delta_bpm: 8,
    residual_bpm: 8,
    pace_corrected: false,
    attribution: "thermal_drift",
  });

  assert.deepEqual(result.split_decay, {
    laps_used: 4,
    first_half_pace_s_per_km: 300,
    second_half_pace_s_per_km: 300,
    pace_drift_pct: 0,
    split: "even",
    last_lap_decay_pct: 0,
  });

  // 当日计划：节奏跑 10km（质量课），实际 12km easy → 距离 +2，强度偏易。
  assert.deepEqual(result.plan_deviation, { distance_km: 2, intensity: "easier_than_planned" });
  assert.equal(result.plan_intent.available, true);
  if (result.plan_intent.available) {
    assert.deepEqual(result.plan_intent.sessions, [{ summary: "节奏跑 10km", distance_km: 10, is_quality: true }]);
  }

  // 阈值定位：1000/3.9 m/s = 256 s/km；147/168 = 87.5%；300/256 = 117.2%。
  assert.deepEqual(result.calibration, {
    threshold_hr: 168,
    threshold_pace_s_per_km: 256,
    hr_pct_of_threshold: 87.5,
    pace_pct_of_threshold: 117.2,
  });

  assert.deepEqual(result.load_position, {
    available: true,
    as_of: "2026-10-09",
    day_dose: 95,
    form: -4.5,
    load_ratio: 1.15,
    week_quality_count: 1,
    week_quality_classes: ["interval"],
  });
  assert.deepEqual(result.provenance, { source: "stride", vendor_derived: false });
});

test("insights: pace-explained drift and negative split under mild weather", async () => {
  const activity = makeActivity({
    feelsLike: 15,
    humidity: 50,
    laps: [lap(1, 3000, 320, 140), lap(2, 3000, 320, 140), lap(3, 3000, 300, 140), lap(4, 3000, 300, 140)],
  });
  const result = await invoke(makeProvider({ activity }));
  assert.equal(result.available, true);
  if (!result.available) return;

  // 后半程快 6.25% → negative split；末 lap 比全程加权平均快 3.2%。
  assert.deepEqual(result.split_decay, {
    laps_used: 4,
    first_half_pace_s_per_km: 320,
    second_half_pace_s_per_km: 300,
    pace_drift_pct: -6.2,
    split: "negative",
    last_lap_decay_pct: -3.2,
  });
  // HR 不变且配速变快 → 残差 0，漂移完全被配速解释（温和天气也不进 unexplained）。
  assert.deepEqual(result.hr_drift, {
    laps_used: 4,
    first_half_hr: 140,
    second_half_hr: 140,
    hr_delta_bpm: 0,
    residual_bpm: 0,
    pace_corrected: true,
    attribution: "pace_explained",
  });
});

test("insights: unexplained drift when residual persists in mild weather", async () => {
  const activity = makeActivity({
    feelsLike: 15,
    humidity: 50,
    laps: [lap(1, 3000, 300, 140), lap(2, 3000, 300, 141), lap(3, 3000, 300, 150), lap(4, 3000, 300, 150)],
  });
  const result = await invoke(makeProvider({ activity }));
  assert.equal(result.available, true);
  if (!result.available) return;

  // 配速全程恒定（无可校正斜率），前半程 140.5 → 后半程 150，残差 9.5，非热天 → 归因不明。
  assert.equal(result.hr_drift.attribution, "unexplained_drift");
  assert.equal(result.hr_drift.residual_bpm, 9.5);
});

test("insights: degrades per field for a brand-new user", async () => {
  const result = await invoke(makeProvider({ activity: makeActivity() }));
  assert.equal(result.available, true);
  if (!result.available) return;

  assert.deepEqual(result.efficiency_delta, { n: 0, reason: "no_baseline" });
  assert.deepEqual(result.hr_drift, { available: false, reason: "insufficient_lap_hr_data" });
  assert.deepEqual(result.split_decay, { available: false, reason: "insufficient_lap_data" });
  assert.deepEqual(result.plan_intent, { available: false, reason: "no_active_weekly_plan" });
  assert.equal(result.plan_deviation, null);
  assert.deepEqual(result.calibration, null);
  assert.deepEqual(result.load_position, {
    available: false,
    as_of: null,
    day_dose: 92.5,
    form: null,
    load_ratio: null,
    week_quality_count: 0,
    week_quality_classes: [],
  });
});

test("insights: laps without HR still yield splits, but no drift attribution", async () => {
  const noHrLaps = [
    lap(1, 3000, 320, null),
    lap(2, 3000, 320, null),
    lap(3, 3000, 300, null),
    lap(4, 3000, 300, null),
  ];
  const result = await invoke(makeProvider({ activity: makeActivity({ laps: noHrLaps }) }));
  assert.equal(result.available, true);
  if (!result.available) return;

  // split 成功分支没有 available 字段（只有降级时才有 available:false + reason）。
  assert.ok(!("reason" in result.split_decay));
  assert.equal(result.split_decay.split, "negative");
  assert.equal(result.split_decay.laps_used, 4);
  assert.deepEqual(result.hr_drift, { available: false, reason: "insufficient_lap_hr_data" });
});

test("insights: unavailable paths and runtime guards", async () => {
  assert.deepEqual(await invoke(makeProvider({ activity: null })), {
    available: false,
    reason: "activity_not_found",
    provenance: { source: "stride", vendor_derived: false },
  });
  assert.deepEqual(await invoke(makeProvider({ activity: makeActivity({ sport: "strength", sportName: null }) })), {
    available: false,
    reason: "not_a_running_activity",
    provenance: { source: "stride", vendor_derived: false },
  });

  // session_class 未算出 → 基线无从谈起。
  const noClass = await invoke(makeProvider({ activity: makeActivity({ strideSessionClass: null }) }));
  assert.deepEqual((noClass as { efficiency_delta: unknown }).efficiency_delta, { n: 0, reason: "session_class_missing" });

  const [tool] = createActivityInsightTools(makeProvider());
  assert.ok(tool);
  await assert.rejects(() => tool.invoke({ labelId: "L1" }, {}), /missing userId/);
  await assert.rejects(() => tool.invoke({ labelId: "L1" }, { context: { userId } }), /missing asof/);
});
