import assert from "node:assert/strict";
import { test } from "node:test";
import { ATHLETES, type AthleteName, buildAthleteEvidence } from "../fixtureLoader.js";
import { listLoadCases } from "../load/fixtureLoader.js";
import type { ContentWeekRow } from "./doctrine.js";
import { templateFallback } from "./fallback.js";
import { projectZones } from "./project.js";
import { QUALITY_FAMILY_OF } from "./testSupport.js";
import { validateWeekContent } from "./validators.js";

/**
 * 兜底合法性扫描（devops#811 验收「兜底永远合法」）：38 案例 L3 golden 周骨架
 * × 三运动员投影带，模板直出逐周过全套校验（一致性 + C1-C9）。覆盖 recovery/
 * absorb/taper/race 全角色与 injury 低量周（10km）——allocator 必须在 C9 分层带
 * 与 C1 守恒之间找到可行解。
 */

const PLAN_START_MONDAY = "2026-10-19";
const parseHms = (s: string) =>
  s
    .split(":")
    .map(Number)
    .reduce((acc, p) => acc * 60 + p, 0);

test("38 案例 × 投影带：模板兜底逐周一致性+C1-C9 全绿", async () => {
  const cases = await listLoadCases();
  assert.equal(cases.length, 38);
  const evidenceCache = new Map<AthleteName, number>();
  for (const c of cases) {
    const spec = ATHLETES[c.athlete];
    if (!evidenceCache.has(c.athlete)) evidenceCache.set(c.athlete, (await buildAthleteEvidence(c.athlete)).current_capability.vdot ?? 0);
    const vdot = evidenceCache.get(c.athlete)!;
    const targetSec = parseHms(spec.targetTime);
    const projection = projectZones(vdot, targetSec, 42195, c.runwayWeeks);
    const rows: ContentWeekRow[] = c.expected.map((w) => ({
      week: w.week,
      phase: w.canonical,
      role: w.role,
      totalKm: w.km,
      longRunKm: w.lr,
      qualitySessions: w.q,
      qualityFamily: QUALITY_FAMILY_OF[w.canonical] ?? "",
      zones: projection.weeks[w.week - 1]!.zones,
    }));
    const input = {
      rows,
      athlete: { weeklyRunDaysMax: spec.weeklyRunDaysMax, weekKm: 60, fitness: { ctl: 60, atl: 55, form: 5 } },
      race: { name: "测试马拉松", date: raceDateOf(PLAN_START_MONDAY, c.runwayWeeks), targetTime: spec.targetTime, goalPaceSKm: targetSec / 42.195 },
      planStartMonday: PLAN_START_MONDAY,
    };
    const weeks = templateFallback(input);
    for (const { week, sessions } of weeks) {
      const row = rows[week - 1]!;
      const checks = validateWeekContent({
        sessions: sessions.map((workout) => ({ workout })),
        row: { total_km: row.totalKm, long_run_km: row.longRunKm, quality_sessions: row.qualitySessions },
        zones: row.zones,
        maxTrainingDays: spec.weeklyRunDaysMax,
        ...(row.role === "race" ? { raceDate: input.race.date } : {}),
        ...(row.phase === "recovery" ? { regeneration: true } : {}),
      });
      const failed = checks.filter((x) => !x.pass);
      assert.deepEqual(failed, [], `${c.athlete}/${c.scenario} 第${week}周（km=${row.totalKm} lr=${row.longRunKm} q=${row.qualitySessions}）`);
    }
  }
});

/** 比赛周周日 = 计划起点 + (N−1) 周 + 6 天。 */
function raceDateOf(planStartMonday: string, runwayWeeks: number): string {
  const d = new Date(`${planStartMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (runwayWeeks - 1) * 7 + 6);
  return d.toISOString().slice(0, 10);
}
