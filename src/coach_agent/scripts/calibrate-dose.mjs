#!/usr/bin/env node
/**
 * L4b 剂量系数标定脚本（devops#799）：
 *   node scripts/calibrate-dose.mjs <snapshot.json|extract.tsv>
 *
 * 输入两种形态：
 * ① 进仓快照 phasing/fixtures/dose-calibration-*.json（默认缺省）——重拟合复现；
 * ② 新提取的 TSV（提取 SQL 见 docs/coach_agent/dose-calibration-report.md §5，
 *   mysql --batch --raw 导出）——再标定：打印拟合报告+建议常数，人工确认后更新
 *   dose.ts DEFAULT_DOSE_COEFFICIENTS+COEFFICIENT_VERSION、coach.yaml
 *   training_plan.dose_coefficients 与报告，快照随行进仓（复现单测钉住）。
 * 拟合器单源 schedule/dose.ts fitDoseCoefficients（单测同源）。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fitDoseCoefficients } from "../dist/graph/master_plan/phasing/content/schedule/dose.js";

const args = process.argv.slice(2);
const input = args[0] ?? resolve(import.meta.dirname, "../src/graph/master_plan/phasing/fixtures/dose-calibration-2026-10-29.json");

async function rowsFromSnapshot(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return raw.rows.map((r) => ({ bands: [r[7], r[8], r[9], r[10], r[11]], dose: r[4] }));
}

async function rowsFromTsv(path) {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const head = lines[0].split("\t");
  const col = (name) => head.indexOf(name);
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    return {
      bands: [Number(cells[col("e_min")]), Number(cells[col("m_min")]), Number(cells[col("t_min")]), Number(cells[col("i_min")]), Number(cells[col("r_min")])],
      dose: Number(cells[col("training_dose")]),
    };
  });
}

const rows = input.endsWith(".json") ? await rowsFromSnapshot(input) : await rowsFromTsv(input);
const report = fitDoseCoefficients(rows);
console.log(`n=${report.n}  R²=${report.r2}  RMSE=${report.rmse}（剂量均值口径）`);
console.log(`残差 |p50|=${report.residualP50}  |p90|=${report.residualP90}`);
console.log(
  `曝光(h)  E=${report.exposureHours[0]}  M=${report.exposureHours[1]}  T=${report.exposureHours[2]}  I=${report.exposureHours[3]}  R=${report.exposureHours[4]}`,
);
const { E, M, T, I, R } = report.coefficients;
console.log("\n系数（dose/min）：");
console.log(`  E: ${E}   M: ${M}   T: ${T}   I: ${I}   R: ${R}`);
console.log(`  相对 E：1.00 / ${(M / E).toFixed(2)} / ${(T / E).toFixed(2)} / ${(I / E).toFixed(2)} / ${(R / E).toFixed(2)}`);
console.log("\n建议（人工确认后更新 dose.ts + coach.yaml + 报告，版本递增）：");
console.log(`  E: ${E}, M: ${M}, T: ${T}, I: ${I}, R: ${R}`);
