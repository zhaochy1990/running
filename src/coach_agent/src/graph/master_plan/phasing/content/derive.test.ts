import assert from "node:assert/strict";
import test from "node:test";
import type { RunWorkout, WorkoutStep } from "@stride/contract";
import {
  hasCooldown,
  hasQualitySegment,
  hasWarmup,
  isAerobicStep,
  isQualityStep,
  isStrideStep,
  mainQualitySegment,
  type PaceZones,
  qualitySpectrum,
} from "./derive.js";

/** chaoyi 校准带（l4-e2e-shanghai fixture 同源；s/km [快,慢]，r 快端开放）。 */
const ZONES: PaceZones = { easy: [288, 336], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] };

const step = (over: Partial<WorkoutStep> & Pick<WorkoutStep, "step_kind" | "duration" | "target">): WorkoutStep =>
  ({
    note: null,
    hr_cap_bpm: null,
    ...over,
  }) as WorkoutStep;
const pace = (low: number, high: number) => ({ kind: "pace_s_km" as const, low, high });
const dist = (value: number) => ({ kind: "distance_m" as const, value });
const time = (value: number) => ({ kind: "time_s" as const, value });
const OPEN = { kind: "open" as const, low: null, high: null };

const workout = (steps: WorkoutStep[], repeat = 1): RunWorkout => ({
  schema: "run-workout/v1",
  name: "测试课",
  date: "2026-11-03",
  note: null,
  type: null,
  purpose: null,
  blocks: [{ repeat, steps }],
});

test("质量谱：快端开放（R 带下限延伸）、慢端=M 带上沿+10s/km", () => {
  assert.deepEqual(qualitySpectrum(ZONES), { fast: null, slow: 298 });
  assert.equal(qualitySpectrum({ ...ZONES, m: null }), null);
});

test("锚点：100m/18s strides 不算质量段、不占 Q；是短加速步", () => {
  const s100m = step({ step_kind: "work", duration: dist(100), target: OPEN });
  const s18s = step({ step_kind: "work", duration: time(18), target: OPEN });
  assert.equal(isQualityStep(s100m, ZONES), false);
  assert.equal(isQualityStep(s18s, ZONES), false);
  assert.equal(isStrideStep(s100m), true);
  assert.equal(isStrideStep(s18s), true);
  assert.equal(hasQualitySegment(workout([s100m, s18s]), ZONES), false);
});

test("锚点：200m R 重复算质量段（>100m 且折算 ≥30s）", () => {
  const r200 = step({ step_kind: "work", duration: dist(200), target: pace(180, 200) });
  assert.equal(isQualityStep(r200, ZONES), true);
  // R 带内但 150m：距离过线、时长按快端折算 <30s → 不算
  assert.equal(isQualityStep(step({ step_kind: "work", duration: dist(150), target: pace(180, 200) }), ZONES), false);
});

test("锚点：心率 target 步不构成质量段（非配速处方无法上谱，显式规则）", () => {
  const hr = step({ step_kind: "work", duration: time(1200), target: { kind: "hr_bpm", low: 155, high: 165 } });
  assert.equal(isQualityStep(hr, ZONES), false);
  assert.equal(isAerobicStep(hr, ZONES), false);
  assert.equal(hasQualitySegment(workout([hr]), ZONES), false);
});

test("锚点：变速课慢段=有配速处方的 work@easy（有氧段），open 慢跑才是 recovery", () => {
  const slowSegment = step({ step_kind: "work", duration: dist(2000), target: pace(288, 336) });
  assert.equal(isQualityStep(slowSegment, ZONES), false);
  assert.equal(isAerobicStep(slowSegment, ZONES), true);
  // 判定表第 2 行：open target 的 work/warmup/cooldown 步也是有氧段
  assert.equal(isAerobicStep(step({ step_kind: "work", duration: dist(5000), target: OPEN }), ZONES), true);
  assert.equal(isAerobicStep(step({ step_kind: "warmup", duration: dist(2000), target: OPEN }), ZONES), true);
  const openJog = step({ step_kind: "recovery", duration: dist(400), target: OPEN });
  assert.equal(isQualityStep(openJog, ZONES), false);
  assert.equal(isAerobicStep(openJog, ZONES), false);
  // rest 步（不在跑）天然排除
  assert.equal(isQualityStep(step({ step_kind: "rest", duration: time(60), target: OPEN }), ZONES), false);
});

test("锚点：跨带配速合法（MP-10s 处方跨 T+M 仍算质量段）", () => {
  const crossBand = step({ step_kind: "work", duration: dist(3000), target: pace(239, 279) });
  assert.equal(isQualityStep(crossBand, ZONES), true);
  const tooSlow = step({ step_kind: "work", duration: dist(3000), target: pace(280, 320) });
  assert.equal(isQualityStep(tooSlow, ZONES), false);
});

test("锚点：主质量段=展开距离最长者（组合课主段判定、repeat 聚合）", () => {
  const tMain = step({ step_kind: "work", duration: dist(2000), target: pace(235, 249) });
  const jog = step({ step_kind: "recovery", duration: dist(400), target: OPEN });
  const rSecondary = step({ step_kind: "work", duration: dist(1000), target: pace(180, 200) });
  const w = {
    schema: "run-workout/v1" as const,
    name: "组合课",
    date: "2026-11-03",
    note: null,
    type: "T" as const,
    purpose: null,
    blocks: [
      { repeat: 3, steps: [tMain, jog] },
      { repeat: 1, steps: [rSecondary] },
    ],
  };
  const main = mainQualitySegment(w, ZONES);
  assert.ok(main != null);
  assert.equal(main.step, tMain);
  assert.equal(main.distanceM, 6000);
  // 交换长度：R 段更长 → 主段变 R
  const flipped = {
    ...w,
    blocks: [
      { repeat: 3, steps: [{ ...tMain, duration: dist(500) }, jog] },
      { repeat: 1, steps: [rSecondary, { ...rSecondary, duration: dist(3000) }] },
    ],
  };
  assert.equal(mainQualitySegment(flipped, ZONES)!.distanceM, 3000);
});

test("锚点：比赛课（M 配速全马）按质量段判定，无需特殊标记", () => {
  const race = workout([step({ step_kind: "work", duration: dist(42200), target: pace(249, 288) })]);
  assert.equal(hasQualitySegment(race, ZONES), true);
});

test("锚点：open duration 步不可判质量（时长距离都不可估）", () => {
  assert.equal(isQualityStep(step({ step_kind: "work", duration: { kind: "open", value: null }, target: pace(235, 249) }), ZONES), false);
});

test("热身/放松在场：看首/末块", () => {
  const wu = step({ step_kind: "warmup", duration: dist(2000), target: OPEN });
  const cd = step({ step_kind: "cooldown", duration: dist(2000), target: OPEN });
  const body = step({ step_kind: "work", duration: dist(8000), target: pace(249, 288) });
  const w = workout([wu, body, cd]);
  assert.equal(hasWarmup(w), true);
  assert.equal(hasCooldown(w), true);
  assert.equal(hasWarmup(workout([body, cd])), false);
  assert.equal(hasCooldown(workout([wu, body])), false);
  // 首块 warmup 在中场块中不算（只看首块）
  const nested = {
    ...workout([]),
    blocks: [
      { repeat: 1, steps: [body] },
      { repeat: 1, steps: [wu, cd] },
    ],
  };
  assert.equal(hasWarmup(nested), false);
  assert.equal(hasCooldown(nested), true);
});
