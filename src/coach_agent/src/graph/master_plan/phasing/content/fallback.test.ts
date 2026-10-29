import assert from "node:assert/strict";
import { test } from "node:test";
import { ATHLETES, type AthleteName, buildAthleteEvidence } from "../fixtureLoader.js";
import { listLoadCases } from "../load/fixtureLoader.js";
import type { ContentWeekRow } from "./doctrine.js";
import { templateFallback } from "./fallback.js";
import { projectZones } from "./project.js";
import { QUALITY_FAMILY_OF } from "./testSupport.js";
import { LR_EVE_MAX_KM, sessionKm, validateWeekContent, weekdayOf } from "./validators.js";

/**
 * 兜底合法性扫描（devops#811 验收「兜底永远合法」）：38 案例 L3 golden 周骨架
 * × 三运动员投影带，模板直出逐周过全套校验（一致性 + C1-C9）。覆盖 recovery/
 * absorb/taper/race 全角色与 injury 低量周（10km）——allocator 必须在 C9 分层带
 * 与 C1 守恒之间找到可行解。附带 #825 两项模板修复的形状断言：常规周 LR 前日
 * （周六）E ≤8km 或无课；赛周恰一节 M 配速激活短课（主体 3-5km+strides，
 * 赛前 2-3 天）。
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
      // #825-①：常规周 LR 前日（周六）——有课则 ≤8km
      if (row.role !== "race") {
        for (const s of sessions.filter((x) => weekdayOf(x.date) === 5)) {
          assert.ok((sessionKm(s) ?? 0) <= LR_EVE_MAX_KM + 0.1, `${c.athlete}/${c.scenario} 第${week}周 LR前日 ${s.name} ${sessionKm(s)?.toFixed(1)}km 超帽`);
        }
      }
      // #825-②：赛周恰一节 M 激活短课（赛前 2-3 天、主体 3-5km+strides）
      if (row.role === "race") {
        const acts = sessions.filter((x) => x.name.startsWith("赛前激活 M"));
        assert.equal(acts.length, 1, `${c.athlete}/${c.scenario} 第${week}周 M 激活课 ${acts.length} 节`);
        const act = acts[0]!;
        const gap = weekdayOf(input.race.date) - weekdayOf(act.date);
        assert.ok(gap === 2 || gap === 3, `${c.athlete}/${c.scenario} 第${week}周 M 激活课距赛 ${gap} 天`);
        const bodyKm = act.blocks[0]!.steps.filter(
          (st) => st.step_kind === "work" && st.target.kind === "pace_s_km" && st.duration.kind === "distance_m",
        ).reduce((s2, st) => s2 + (st.duration.kind === "distance_m" ? st.duration.value : 0) / 1000, 0);
        assert.ok(bodyKm >= 3 && bodyKm <= 5, `M 激活主体 ${bodyKm.toFixed(1)}km ∉ [3,5]`);
        assert.ok(
          act.blocks.some((b) => b.steps.some((st) => st.step_kind === "work" && st.target.kind === "open" && st.duration.kind === "distance_m")),
          "M 激活课缺 strides",
        );
      }
    }
  }
});

/** 比赛周周日 = 计划起点 + (N−1) 周 + 6 天。 */
function raceDateOf(planStartMonday: string, runwayWeeks: number): string {
  const d = new Date(`${planStartMonday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (runwayWeeks - 1) * 7 + 6);
  return d.toISOString().slice(0, 10);
}

test("赛周 M 激活包络边界（#825）：精英带+触底骨架装不下激活课 → 不破 3km 拍板下限，C3 如实挂出", () => {
  // easy 带中点 220s/km（阈值 ≈227s/km 以下）：M 激活固定形状（25min E≈6.8km+strides 0.4km）+3km 主体
  // > 10km 激活预算——不静默缩主体换过门（#814 哲学：数学无解上报，不用兜底掩盖）
  const zones = { easy: [205, 235], m: [180, 205], t: [168, 180], i: [155, 168], r: [null, 155] } as const;
  const rows: ContentWeekRow[] = [
    { week: 1, phase: "final_quality", role: "race", totalKm: 52.2, longRunKm: null, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones },
  ];
  const input = {
    rows,
    athlete: { weeklyRunDaysMax: 6, weekKm: 60, fitness: { ctl: 60, atl: 55, form: 5 } },
    race: { name: "测试马拉松", date: "2026-10-25", targetTime: "2:35:00", goalPaceSKm: 9300 / 42.195 },
    planStartMonday: PLAN_START_MONDAY,
  };
  const sessions = templateFallback(input)[0]!.sessions;
  assert.equal(sessions.filter((s) => s.name.startsWith("赛前激活 M")).length, 0, "不应出现缩水 M 激活课");
  const checks = validateWeekContent({
    sessions: sessions.map((workout) => ({ workout })),
    row: { total_km: 52.2, long_run_km: null, quality_sessions: 2 },
    zones,
    maxTrainingDays: 6,
    raceDate: input.race.date,
  });
  const c3 = checks.find((c) => c.id === "C3 Q配额")!;
  assert.equal(c3.pass, false, "包络边界应如实挂 C3（比赛课 1 节 vs 配额 2）");
});
