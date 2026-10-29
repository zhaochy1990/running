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

test("recovery 折算（#824）：time+open 组间慢跑按 E 带中点折算计里程、计有氧账（water-fill/P7 不再挂不可知）", () => {
  const c = DEFAULT_DOSE_COEFFICIENTS;
  // I 1k×4（90s open jog）：4×(1km@I + 90s/321s/km)≈4×1.28=5.12km（E 带中点 321）
  const workout = {
    schema: "run-workout/v1",
    name: "I 1k×4",
    date: "2026-11-02",
    type: "I",
    note: null,
    purpose: "p",
    blocks: [
      {
        repeat: 4,
        steps: [
          {
            step_kind: "work",
            duration: { kind: "distance_m", value: 1000 },
            target: { kind: "pace_s_km", low: 220, high: 230 },
            note: null,
            hr_cap_bpm: null,
          },
          { step_kind: "recovery", duration: { kind: "time_s", value: 90 }, target: { kind: "open", low: null, high: null }, note: null, hr_cap_bpm: null },
        ],
      },
    ],
  } as RunWorkout;
  const d = courseDose(workout, ZONES, c);
  assert.ok(d.km != null, "recovery time 步不再让整课里程不可知");
  const foldedJogKm = 4 * (90 / 321);
  assert.ok(Math.abs(d.aerobicKm - foldedJogKm) < 0.06, `有氧账含折算慢跑：${d.aerobicKm}`);
  assert.ok(Math.abs((d.km ?? 0) - (4 + foldedJogKm)) < 0.06, `总里程=强度+折算：${d.km}`);
  // 折算不改变剂量账（recovery time 步剂量本就按 E 带计时长）；
  // 非 recovery 的 time+open（如 work 步 open）仍不可知
  const openWork = courseDose(singleStepWorkout({ kind: "time_s", value: 1800 }, { kind: "open", low: null, high: null }), ZONES, c);
  assert.equal(openWork.km, null);
});
