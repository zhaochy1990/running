import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RACE_DISTANCES_M } from "@stride/contract";
import { projectZones } from "../content/project.js";
import { ATHLETES, type AthleteName, buildAthleteEvidence, loadAthlete } from "../fixtureLoader.js";
import { type PhaseDivisionIntent, PhaseDivisionIntentSchema } from "../intent.js";
import { LONG_RUN_MAX_KM, longRunMaxKmOfZone } from "../sessionCaps.js";
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
const parseHms = (value: string): number => value.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);

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
export async function buildCaseContext(
  athlete: AthleteName,
  injury: boolean,
): Promise<{ baseline: HabitualBaseline; recentWeeksKm: number[]; longRunMaxKm: number }> {
  const { activities } = await loadAthlete(athlete);
  const series = buildWeeklySeries(activities, LOAD_AS_OF);
  const evidence = await buildAthleteEvidence(athlete);
  const vdot = evidence.current_capability.vdot;
  return {
    baseline: habitualBaseline(injury ? injurySeries(series) : series),
    recentWeeksKm: series.weeks.slice(-4).map((w) => w.km),
    // 按能力换算的长跑上限（devops#1054）：与生产入口同一算法——能力投影第 1 周
    // （计划起点 VDOT=min(当前, 目标−2)）的 E 带，不用能力证据里的 pace_zones
    // （两者算法不同，实测有 1-4s/km 之差）；伤退变换不改能力，上限不变
    longRunMaxKm:
      vdot == null
        ? LONG_RUN_MAX_KM
        : longRunMaxKmOfZone(projectZones(vdot, parseHms(ATHLETES[athlete].targetTime), RACE_DISTANCES_M.FM, 1).weeks[0]!.zones.easy),
  };
}
