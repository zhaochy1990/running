import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWeeklySeries, habitualBaseline } from "./baseline.js";
import { injurySeries, makeSeries } from "./testSupport.js";

/** R0-R5 分支语义（devops#793 A 节，21 用户两轮实测校准的分支覆盖）。 */

const close = (a: number, b: number, tol = 0.15) => Math.abs(a - b) <= tol;

test("R2：近 12 周有效周 ≥3 → 中位数（median@12w）", () => {
  const kms = Array.from({ length: 28 }, (_, i) => (i < 16 ? 20 : [40, 50, 60, 70][i % 4]!));
  const b = habitualBaseline(makeSeries(kms));
  assert.equal(b.level, "median@12w");
  // 近 12 周有效周中位数 = 55（40/50/60/70 各三周的中间值）
  assert.ok(close(b.week_km, 55, 1));
  assert.equal(b.scenario, "normal");
  assert.equal(b.acwr_applicable, true);
});

test("R1：比赛周/赛后 14 天/taper 特征/断练周剔除后不足 3 → 扩 16/24 周窗口", () => {
  // 近 12 周只剩 2 个有效周（其余 <15km 断练），扩 16 周窗后取到中位
  const kms = Array.from({ length: 28 }, (_, i) => (i < 16 ? 50 : i < 26 ? 5 : 60));
  const b = habitualBaseline(makeSeries(kms));
  assert.equal(b.level, "median@16w");
});

test("R2 兜底链：24 周内仅 2 有效周 → best2；全无 → fallback_recent4（ACWR 不适用）", () => {
  const two = habitualBaseline(makeSeries(Array.from({ length: 28 }, (_, i) => (i === 20 || i === 22 ? 50 : 3))));
  assert.equal(two.level, "best2");
  assert.ok(two.week_km > 10 && two.week_km < 25, `week_km=${two.week_km}`); // 断练场景 0.4×衰减后基线
  const none = habitualBaseline(makeSeries(Array.from({ length: 28 }, () => 3)));
  assert.equal(none.level, "fallback_recent4");
  assert.equal(none.scenario, "fallback_avg4");
  assert.equal(none.acwr_applicable, false);
});

test("R4 断练回归：avg4<15km → 0.4×衰减基线 + ACWR 不适用显式标记", () => {
  // 基线（近 12 周有效中位）=60，但近 4 周滑落到 10km
  const kms = Array.from({ length: 28 }, (_, i) => (i < 24 ? 60 : 10));
  const b = habitualBaseline(makeSeries(kms));
  assert.equal(b.scenario, "detrain_return");
  assert.ok(close(b.week_km, 0.4 * 60));
  assert.equal(b.acwr_applicable, false);
});

test("R4 断练回归（尾段形态）：连续断练 ≥2 周 → 0.4×，即便 avg4 仍 ≥15", () => {
  // 近 4 周 [50, 50, 5, 5]：avg4=27.5 ≥15，但尾部连续 2 个断练周
  const kms = Array.from({ length: 28 }, (_, i) => (i >= 26 ? 5 : 50));
  const b = habitualBaseline(makeSeries(kms));
  assert.equal(b.scenario, "detrain_return");
  assert.equal(b.acwr_applicable, false);
});

test("R4 赛后：距赛 ≤21 天 → 0.8×基线", () => {
  const kms = Array.from({ length: 28 }, () => 50);
  const races = [{ date: "2026-10-20", km: 42 }];
  const b = habitualBaseline(makeSeries(kms, races));
  // as_of=2026-10-26，距赛 6 天
  assert.equal(b.scenario, "post_race");
  assert.ok(close(b.week_km, 0.8 * 50));
});

test("R4 能力衰减：基线过期但仍在跑（中位远高于近期均值）→ 0.85×基线", () => {
  // 前 24 周稳定 60km，近 4 周仍在跑但 15km：中位=60（过期）、avg4=15
  const kms = Array.from({ length: 28 }, (_, i) => (i < 24 ? 60 : 15));
  const b = habitualBaseline(makeSeries(kms));
  assert.equal(b.scenario, "stale");
  assert.equal(b.acwr_applicable, true);
  assert.ok(Math.abs(b.week_km - 1.3 * 15) < 0.2, `week_km=${b.week_km}`); // 0.85×60 后仍被 R5 帽 1.3×avg4 收敛
});

test("R3 新鲜度衰减：距最后 ≥15km 周 4 周内不衰减，超 4 周起 ×0.97/周、下限 0.65", () => {
  const stale5 = habitualBaseline(makeSeries(Array.from({ length: 28 }, (_, i) => (i < 23 ? 50 : 3))));
  assert.ok(close(stale5.decay_factor, 0.97, 0.02)); // 超 1 周
  const veryStale = habitualBaseline(makeSeries(Array.from({ length: 28 }, (_, i) => (i < 2 ? 50 : 3))));
  assert.ok(close(veryStale.decay_factor, 0.65, 0.02)); // 触底
});

test("R5 硬安全门：avg4≥15 时起点 ≤1.3×avg4", () => {
  // 近 12 周有效周中位 100（历史高量），但近 4 周只有 40
  const kms = Array.from({ length: 28 }, (_, i) => (i < 24 ? 100 : 40));
  const b = habitualBaseline(makeSeries(kms));
  assert.ok(b.week_km <= 1.3 * 40 + 0.2, `week_km=${b.week_km}`);
});

test("R0/R1：周序列补零（周一对齐）、比赛周与赛后 14 天不计入有效周、起点下限 10", () => {
  const acts = [
    { date: "2026-09-28", distanceM: 30000, name: "课", sport: null, sportName: null, strideSessionClass: "easy" },
    { date: "2026-10-05", distanceM: 30000, name: "课", sport: null, sportName: null, strideSessionClass: "long" },
    { date: "2026-10-12", distanceM: 42000, name: "比赛", sport: null, sportName: null, strideSessionClass: "race" },
  ];
  const series = buildWeeklySeries(acts, "2026-10-28"); // 周三 as_of：桶仍按周一对齐
  // 28 周全补零（没跑的周记 0，跳零周会令断练期均值虚高数倍）
  assert.equal(series.weeks.length, 28);
  assert.equal(series.weeks.filter((w) => w.km === 0).length, 25);
  assert.equal(series.weeks.find((w) => w.race)?.weekStart, "2026-10-12");
  assert.ok(series.weeks.find((w) => w.weekStart === "2026-10-19")!.postRace); // 赛后 14 天内
  const b = habitualBaseline(series);
  assert.ok(b.week_km >= 10);
});

test("taper 特征周剔除：量 < 前 3 周均值 70% 且后续 21 天内有比赛的周不算有效周", () => {
  // 稳定 50km → 赛前 2 周降到 30（<35=70%）且 21 天内有比赛 → 被剔除
  const kms = Array.from({ length: 26 }, () => 50).concat([30, 30]);
  const races = [{ date: "2026-10-25", km: 42 }];
  const withRace = habitualBaseline(makeSeries(kms, races));
  assert.equal(withRace.scenario, "post_race");
});

test("伤退场景变换（回放口径）：近 6 周砍半只作用于基线，滚动均值种子仍为实际周", () => {
  const series = makeSeries(Array.from({ length: 28 }, (_, i) => (i < 22 ? 80 : 70)));
  const b = habitualBaseline(injurySeries(series));
  // 砍半后基线中位 ≈ 0.45×70~80 区段；R5 帽 1.3×avg4(≈31.5) 生效
  assert.ok(b.week_km <= 1.3 * 31.5 + 0.2, `week_km=${b.week_km}`);
});
