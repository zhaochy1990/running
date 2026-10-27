import assert from "node:assert/strict";
import { test } from "node:test";
import { RACE_DISTANCES_M, raceTimeSecFromVdot, vdotFromRace } from "../vdot.js";
import { projectZones } from "./project.js";

/**
 * projectZones 单测（devops#811 验收）：chaoyi 6 周撞帽曲线逐周值（51.1→…→52.85，
 * daniels-l4-content.md §4 数据标定例）、supported 档直线精确抵达、gap≤0 恒定、
 * 档位跨越处帽切换、带换算同源性。
 */

const FM = RACE_DISTANCES_M.FM;
/** chaoyi 2:50:00 的目标 VDOT（fixture 实测 ≈57.26，封顶全撞）。 */
const CHAOYI_TARGET_SEC = 2 * 3600 + 50 * 60;

test("chaoyi 6 周撞帽曲线：51.1→51.6→52.1→52.35→52.6→52.85（验收锚点）", () => {
  const { weeks, meta } = projectZones(51.1, CHAOYI_TARGET_SEC, FM, 6);
  assert.deepEqual(
    weeks.map((w) => w.vdot.toFixed(2)),
    ["51.10", "51.60", "52.10", "52.35", "52.60", "52.85"],
  );
  assert.equal(meta.capped, true);
  // 残差 = 57.26 − 52.85 ≈ 4.4（multi_cycle 风险量化素材）；所需斜率 ≈ 1.23/周
  assert.ok(Math.abs(meta.residual - 4.4) <= 0.06, `residual ${meta.residual}`);
  assert.ok(Math.abs(meta.requiredSlope - 1.23) <= 0.01, `slope ${meta.requiredSlope}`);
});

test("supported 档：未撞帽=直线精确抵达（终点=目标 VDOT）、capped=false", () => {
  const targetSec = raceTimeSecFromVdot(FM, 52);
  const { weeks, meta } = projectZones(50, targetSec, FM, 6);
  assert.equal(meta.capped, false);
  assert.equal(meta.residual <= 0.01, true, `residual ${meta.residual}`);
  assert.ok(Math.abs(weeks.at(-1)!.vdot - 52) <= 0.01, `final ${weeks.at(-1)!.vdot}`);
  // 逐周单调递增
  for (let i = 1; i < weeks.length; i++) assert.ok(weeks[i]!.vdot > weeks[i - 1]!.vdot);
});

test("gap≤0 维持：目标不高于当前 → 恒定当前带、无递进", () => {
  const targetSec = raceTimeSecFromVdot(FM, 53);
  const { weeks, meta } = projectZones(55, targetSec, FM, 4);
  assert.deepEqual(
    weeks.map((w) => w.vdot),
    [55, 55, 55, 55],
  );
  assert.equal(meta.capped, false);
  assert.ok(meta.residual < 0, `residual ${meta.residual}`);
});

test("档位跨越处帽切换：51.8 起步，跨 52 档后周增量从 0.5 收到 0.25", () => {
  const targetSec = raceTimeSecFromVdot(FM, 58);
  const { weeks } = projectZones(51.8, targetSec, FM, 8);
  const inc = weeks.slice(1).map((w, i) => Math.round((w.vdot - weeks[i]!.vdot) * 100) / 100);
  // 51.8→52.3（cap 0.5，45-52 档）→ 跨 52 后 0.25 封顶
  assert.deepEqual(
    weeks.map((w) => w.vdot.toFixed(2)),
    ["51.80", "52.30", "52.55", "52.80", "53.05", "53.30", "53.55", "53.80"],
  );
  assert.deepEqual(inc, [0.5, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
});

test("带换算：VDOT 升→配速带整体变快、r 快端开放、取整秒、与阈值反解同源", () => {
  const { weeks } = projectZones(51.1, CHAOYI_TARGET_SEC, FM, 6);
  const first = weeks[0]!.zones;
  const last = weeks.at(-1)!.zones;
  for (const key of ["easy", "m", "t", "i"] as const) {
    assert.ok(first[key]![0]! > last[key]![0]!, `${key} 快端应变快`);
    assert.ok(first[key]![1]! > last[key]![1]!, `${key} 慢端应变快`);
  }
  assert.equal(first.r?.[0] ?? null, null);
  // 带边界为整数秒
  for (const key of ["easy", "m", "t", "i", "r"] as const) assert.ok(first[key]!.every((b) => b == null || Number.isInteger(b)));
  // 锚点：VDOT 51.1 阈值 ≈248.9s/km → easy=[296,346]（0.72/0.84 速度比）
  assert.deepEqual(first.easy, [296, 346]);
});

test("无效入参抛错（NaN / 非正 / 距离域外 / runway<1）", () => {
  assert.throws(() => projectZones(Number.NaN, 10200, FM, 6));
  assert.throws(() => projectZones(51.1, Number.NaN, FM, 6));
  assert.throws(() => projectZones(51.1, 10200, 1000, 6));
  assert.throws(() => projectZones(51.1, 10200, FM, 0));
});

test("runway=1 退化：单周无递进（v0 起点即终点带），requiredSlope=整段 gap", () => {
  const targetSec = raceTimeSecFromVdot(FM, 56);
  const targetVdot = vdotFromRace(FM, targetSec);
  const { weeks, meta } = projectZones(51, targetSec, FM, 1);
  assert.equal(weeks.length, 1);
  // v0 = min(51, 56−2) = 51——起点即唯一一周的带
  assert.equal(weeks[0]!.vdot, 51);
  assert.equal(meta.capped, false);
  assert.ok(Math.abs(meta.requiredSlope - (targetVdot - 51)) <= 0.01);
  assert.ok(Math.abs(meta.residual - (targetVdot - 51)) <= 0.01);
});
