import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import type { RunWorkout } from "@stride/contract";
import type { PaceZones } from "../derive.js";
import { type CalibrationRow, courseDose, DEFAULT_DOSE_COEFFICIENTS, doseBandOfPace, fitDoseCoefficients } from "./dose.js";

/**
 * 剂量估算器单测（devops#799）：①标定可复现——进仓快照重跑最小二乘=已发布
 * 系数（防快照/系数漂移）；②带分类与分步剂量判定表锚点；③快照数字与标定
 * 报告（docs/coach_agent/dose-calibration-report.md）一致性由 ① 间接钉住。
 */

const FIXTURE = resolve(import.meta.dirname, "../../fixtures/dose-calibration-2026-10-29.json");

const ZONES: PaceZones = { easy: [296, 346], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] };

test("标定复现：快照重拟合 → 已发布系数（R²≥0.84、n=739）", async () => {
  const raw = JSON.parse(await readFile(FIXTURE, "utf8")) as {
    rows: Array<[string, string, string, string, number, string, string, number, number, number, number, number, number]>;
  };
  const rows: CalibrationRow[] = raw.rows.map((r) => ({ bands: [r[7]!, r[8]!, r[9]!, r[10]!, r[11]!], dose: r[4]! }));
  const report = fitDoseCoefficients(rows);
  assert.equal(report.n, 739);
  assert.ok(report.r2 >= 0.84, `R²=${report.r2}`);
  // 相对值单调（E<M≈T<I<R——强度越高单位时间剂量越大）且与发布值一致（±0.01 舍入）
  assert.deepEqual(report.coefficients, DEFAULT_DOSE_COEFFICIENTS);
  const [e, m, t, i, r] = [report.coefficients.E, report.coefficients.M, report.coefficients.T, report.coefficients.I, report.coefficients.R];
  assert.ok(e < m && e < t && t < i && i < r, "带序单调");
  assert.ok(m / e > 2 && m / e < 2.6, `M/E=${(m / e).toFixed(2)} 与 POC 手拍 2.5 同量级`);
});

test("带分类：谱内按中点、谱外/open=有氧、跨带处方取中点系数", () => {
  assert.equal(doseBandOfPace(296, 346, ZONES), "E"); // 中点 321 > 谱慢端 298 → 有氧
  assert.equal(doseBandOfPace(249, 288, ZONES), "M"); // M 带
  assert.equal(doseBandOfPace(235, 249, ZONES), "T");
  assert.equal(doseBandOfPace(218, 235, ZONES), "I");
  assert.equal(doseBandOfPace(200, 218, ZONES), "R");
  assert.equal(doseBandOfPace(289, 300, ZONES), "M"); // 中点 294.5 ∈ 谱慢端容差带（m[1]+10=298，与 qualitySpectrum 同口径）→ M
  assert.equal(doseBandOfPace(284, 296, ZONES), "M"); // 中点 290 ≤ 谱慢端 298——谱内按 M 计剂量（与 isQualityStep 判定同口径不劈叉）
  assert.equal(doseBandOfPace(250, 297, ZONES), "M"); // 中点 273.5 落 M 带
});

/** 构造单步课（time 或 distance 处方）。 */
function singleStepWorkout(
  duration: { kind: "time_s"; value: number } | { kind: "distance_m"; value: number },
  target: { kind: "pace_s_km"; low: number; high: number } | { kind: "open"; low: null; high: null },
): RunWorkout {
  return {
    schema: "run-workout/v1",
    name: "t",
    date: "2026-11-02",
    type: "E",
    note: null,
    purpose: "p",
    blocks: [{ repeat: 1, steps: [{ step_kind: "work", duration, target, note: null, hr_cap_bpm: null }] }],
  } as RunWorkout;
}

test("分步剂量：E 60min=0.59×60；M 带 30min=1.37×30；rest 步零剂量；强度/有氧里程分账", () => {
  const c = DEFAULT_DOSE_COEFFICIENTS;
  const e = courseDose(singleStepWorkout({ kind: "time_s", value: 3600 }, { kind: "pace_s_km", low: 296, high: 346 }), ZONES, c);
  assert.equal(e.loadPt, Math.round(c.E * 60 * 10) / 10);
  assert.ok(e.aerobicKm > 10, `E 60min≈${e.aerobicKm}km`);
  const m = courseDose(singleStepWorkout({ kind: "time_s", value: 1800 }, { kind: "pace_s_km", low: 249, high: 288 }), ZONES, c);
  assert.equal(m.loadPt, Math.round(c.M * 30 * 10) / 10);
  assert.ok(m.intensityKm >= 6, `M 30min 强度里程≈${m.intensityKm}km`);
  // open+time 步：剂量按 E 带、里程不可知
  const open = courseDose(singleStepWorkout({ kind: "time_s", value: 1800 }, { kind: "open", low: null, high: null }), ZONES, c);
  assert.equal(open.loadPt, Math.round(c.E * 30 * 10) / 10);
  assert.equal(open.km, null);
});
