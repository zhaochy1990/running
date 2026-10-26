import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AthleteName, loadAthlete } from "../fixtureLoader.js";
import { type PhaseDivisionIntent, PhaseDivisionIntentSchema } from "../intent.js";
import { buildWeeklySeries, type HabitualBaseline, habitualBaseline } from "./baseline.js";
import type { LoadWeek } from "./expand.js";
import { injurySeries } from "./testSupport.js";

/**
 * 三运动员 × 12 跑道 38 案例 L3 fixture（devops#793 G 节）：冻结 L2 真实产出
 * （deepseek-flash，as_of 2026-10-26）+ 展开器期望周骨架（golden，确定性可
 * 重放）。层间解耦：L2 改动不惊动本层回放。活动数据复用 phasing/fixtures
 * （与 spike 同源，周序列已验证一致）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "fixtures");
const LOAD_AS_OF = "2026-10-26";

interface FixtureFile {
  scenario: string;
  runway: number;
  injury: boolean;
  intent: unknown;
  expected: LoadWeek[];
}

export interface LoadFixtureCase extends FixtureFile {
  athlete: AthleteName;
  runwayWeeks: number;
  intent: PhaseDivisionIntent;
}

/** 逐运动员枚举 fixture 案例（目录名=运动员，文件名=场景）。 */
export async function listLoadCases(): Promise<LoadFixtureCase[]> {
  const out: LoadFixtureCase[] = [];
  for (const athlete of (await readdir(FIXTURES, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)) {
    const dir = resolve(FIXTURES, athlete);
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json")).sort()) {
      const raw = JSON.parse(await readFile(resolve(dir, f), "utf8")) as FixtureFile;
      out.push({
        athlete: athlete as AthleteName,
        ...raw,
        runwayWeeks: raw.runway,
        intent: PhaseDivisionIntentSchema.parse(raw.intent),
      });
    }
  }
  return out;
}

/**
 * 场景输入件：R0-R5 基线（伤退场景在基线口径上做砍半变换）+ 滚动均值种子
 * （赛前 4 实际完成周——伤退变换不碰种子，实际跑量就是实际跑量）。
 */
export async function buildCaseContext(athlete: AthleteName, injury: boolean): Promise<{ baseline: HabitualBaseline; recentWeeksKm: number[] }> {
  const { activities } = await loadAthlete(athlete);
  const series = buildWeeklySeries(activities, LOAD_AS_OF);
  return {
    baseline: habitualBaseline(injury ? injurySeries(series) : series),
    recentWeeksKm: series.weeks.slice(-4).map((w) => w.km),
  };
}
