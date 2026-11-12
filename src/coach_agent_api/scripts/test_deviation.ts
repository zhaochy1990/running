import { MySqlDataProvider } from "@stride/coach-agent-worker";
import { assessWeek, assessWeeks, type ActivityRef } from "@stride/coach-agent";
import { addDays, mondayOnOrBefore, shanghaiDay, weekFolder, type WeeklyPlan, WeeklyPlanSchema, type RunWorkout } from "@stride/contract";
import assert from "node:assert/strict";
import { loadApiConfig } from "../src/config.js";
import { coachApiConfigFiles } from "../src/configPaths.js";

/**
 * 偏差检测真实数据验收（#858 PR-B，无 LLM——检测层是纯函数）：
 *   ① provider 拉最近 6 周真实 activities → ActivityRef（跑步行过滤同
 *      isRunLikeActivity 口径：sport/sportName 判跑步）
 *   ② 计划侧**不起 LLM**：用确定性模板构造 6 个周文档（每周 3 run 会话：
 *      周二 I 间歇 6×800m、周四 T 节奏 20min、周日 LR 25km + rest 日，
 *      WeeklyPlanSchema 最小合法形状，逐周过硬校验）
 *   ③ assessWeeks 逐周判定 → 周表打印（周起/计划km/实际km/ratio/质量x/y/
 *      分类/preselect/severe/evidence）+ 断言
 *
 * 注意：计划侧是**模板不是真计划**——目的是让真实活动去撞一个「典型计划」，
 * 看分类是否随真实行为合理分布。真计划的检测由 PR-C 夜检接线（读 weekly 行）。
 * env：ROLL_DUMP=path（全量 JSON 导出）。
 */

type Profile = "local" | "prod";
const PROFILE = "prod" as Profile;
process.env.STRIDE_COACH_ENV = PROFILE;
const USER_ID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";
const WEEKS = 6;

const store = MySqlDataProvider.create(loadApiConfig({ configFiles: coachApiConfigFiles(import.meta.url) }).strideDatabase);

// ── 确定性模板计划（配速带取 2:50 量级跑者的典型带：I 205-215 / T 245-255 / LR 330-370；
//    有氧包裹 3km+3km——质量课合计 10.8km，与真实活动的质量课体量同量级，避免
//    距离容差把一切质量活动都拒配、分类退化成清一色 ran_other）──

function templateRunSpec(date: string, name: string, type: RunWorkout["type"]): RunWorkout {
  const warmup = { step_kind: "warmup" as const, duration: { kind: "distance_m" as const, value: 3000 }, target: { kind: "open" as const, low: null, high: null }, note: null, hr_cap_bpm: null };
  const cooldown = { step_kind: "cooldown" as const, duration: { kind: "distance_m" as const, value: 3000 }, target: { kind: "open" as const, low: null, high: null }, note: null, hr_cap_bpm: null };
  if (type === "I") {
    return {
      schema: "run-workout/v1",
      name,
      date,
      note: null,
      type,
      purpose: null,
      blocks: [
        { repeat: 1, steps: [warmup] },
        {
          repeat: 6,
          steps: [
            { step_kind: "work", duration: { kind: "distance_m", value: 800 }, target: { kind: "pace_s_km", low: 205, high: 215 }, note: null, hr_cap_bpm: null },
            { step_kind: "rest", duration: { kind: "time_s", value: 120 }, target: { kind: "open", low: null, high: null }, note: null, hr_cap_bpm: null },
          ],
        },
        { repeat: 1, steps: [cooldown] },
      ],
    };
  }
  if (type === "T") {
    return {
      schema: "run-workout/v1",
      name,
      date,
      note: null,
      type,
      purpose: null,
      blocks: [
        { repeat: 1, steps: [warmup] },
        { repeat: 1, steps: [{ step_kind: "work", duration: { kind: "time_s", value: 1200 }, target: { kind: "pace_s_km", low: 245, high: 255 }, note: null, hr_cap_bpm: null }] },
        { repeat: 1, steps: [cooldown] },
      ],
    };
  }
  return {
    schema: "run-workout/v1",
    name,
    date,
    note: null,
    type: "LR",
    purpose: null,
    blocks: [{ repeat: 1, steps: [{ step_kind: "work", duration: { kind: "distance_m", value: 25000 }, target: { kind: "pace_s_km", low: 330, high: 370 }, note: null, hr_cap_bpm: null }] }],
  };
}

/** 模板周文档：周二 I 10.8km + 周四 T 10.8km + 周日 LR 25km（计划 46.6km/周）+ 4 个 rest 日。 */
function templateWeekDoc(weekStart: string, weekIndex: number): WeeklyPlan {
  const runs = [
    { date: addDays(weekStart, 1), summary: "间歇 6×800m", km: 10.8, type: "I" as const },
    { date: addDays(weekStart, 3), summary: "节奏跑 20 分钟", km: 10.8, type: "T" as const },
    { date: addDays(weekStart, 6), summary: "长跑 25km", km: 25, type: "LR" as const },
  ];
  const sessions = [
    ...runs.map((run, index) => ({
      schema: "plan-session/v1" as const,
      date: run.date,
      session_index: index,
      kind: "run" as const,
      summary: run.summary,
      notes_md: null,
      total_distance_m: run.km * 1000,
      total_duration_s: null,
      estimated_dose: null,
      spec: templateRunSpec(run.date, run.summary, run.type),
    })),
    ...[0, 2, 4, 5].map((offset) => ({
      schema: "plan-session/v1" as const,
      date: addDays(weekStart, offset),
      session_index: 0,
      kind: "rest" as const,
      summary: "休息",
      notes_md: null,
      total_distance_m: null,
      total_duration_s: null,
      estimated_dose: null,
      spec: null,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.session_index - b.session_index);
  return WeeklyPlanSchema.parse({
    schema: "weekly-plan/v1",
    week_name: weekFolder(weekStart),
    sessions,
    nutrition: Array.from({ length: 7 }, (_, offset) => ({
      schema: "plan-nutrition/v1",
      date: addDays(weekStart, offset),
      kcal_target: null,
      carbs_g: null,
      protein_g: null,
      fat_g: null,
      water_ml: null,
      meals: [],
      notes_md: null,
    })),
    notes_md: null,
    coach_notes: "偏差检测验收模板周（非真计划，真计划由 PR-C 夜检读 weekly 行）",
    week_index: weekIndex,
  });
}

async function main() {
  try {
    // ── ① 最近 6 周真实活动（含进行中的当前周；当前周半程数据打印为准，夜检在周末跑）──
    const thisMonday = mondayOnOrBefore(shanghaiDay(new Date().toISOString()));
    const weekStarts = Array.from({ length: WEEKS }, (_, index) => addDays(thisMonday, (index - WEEKS + 1) * 7));
    const summaries = await store.getActivitySummariesByDateRange(USER_ID, weekStarts[0]!, addDays(thisMonday, 6));
    // 跑步行过滤（isRunLikeActivity 同口径；DB 行必带厂商 sport 信息，>2km 兜底分支不触发）。
    const activities: ActivityRef[] = summaries
      .filter((row) => row.sport?.toLowerCase().startsWith("run") === true || row.sportName?.toLowerCase().includes("run") === true)
      .map((row) => ({
        day: row.shanghaiDay,
        name: row.name ?? "(未命名)",
        distanceKm: Math.round(((row.distanceM ?? 0) / 1000) * 100) / 100,
        durationS: row.durationS ?? 0,
        avgPaceSKm: row.avgPaceSKm,
        sessionClass: row.strideSessionClass,
      }));
    console.log(`[deviation] 活动 ${summaries.length} 行（跑步 ${activities.length} 行），窗口 ${weekStarts[0]} ~ ${addDays(thisMonday, 6)}`);

    // ── ② 模板计划 6 周（逐周过硬校验，构造即断言契约合法）──
    const weekDocs = weekStarts.map((weekStart, index) => templateWeekDoc(weekStart, index + 1));

    // ── ③ 逐周判定 + 周表（活动传全量，assessWeeks 内部按周自筛）──
    const full = assessWeeks({ weekDocs, activities });

    const header = ["周起", "计划km", "实际km", "ratio", "质量", "LR", "分类", "preselect", "severe", "evidence"];
    console.log(`[deviation] ${header.join(" | ")}`);
    for (const deviation of full) {
      const row = [
        deviation.weekStart,
        deviation.plannedKm.toFixed(1),
        deviation.actualKm.toFixed(1),
        deviation.deliveryRatio.toFixed(2),
        `${deviation.qualityDone}/${deviation.qualityPlanned}`,
        deviation.longRunDone === null ? "-" : deviation.longRunDone ? "√" : "×",
        deviation.class,
        deviation.preselect ?? "-",
        deviation.severe ? "Y" : "-",
        deviation.evidence,
      ];
      console.log(`[deviation] ${row.join(" | ")}`);
    }

    // ── 断言 ──
    // 1) 6 周全产出合法 WeekDeviation（不抛错；within_tolerance ⇔ preselect=null）。
    assert.equal(full.length, WEEKS);
    for (const deviation of full) {
      assert.ok(deviation.evidence.length > 0, `${deviation.weekStart} evidence 非空`);
      if (deviation.class === "within_tolerance") assert.equal(deviation.preselect, null);
      else assert.ok(deviation.preselect !== null, `${deviation.weekStart} 偏差周必须有 preselect`);
      // 比率算术自洽（允许 0.2km 的 r1 舍入差）。
      if (deviation.plannedKm > 0)
        assert.ok(Math.abs(deviation.plannedKm * deviation.deliveryRatio - deviation.actualKm) < 0.2, `${deviation.weekStart} ratio 与 km 不自洽`);
    }
    const classCounts = new Map<string, number>();
    for (const deviation of full) classCounts.set(deviation.class, (classCounts.get(deviation.class) ?? 0) + 1);
    console.log(`[deviation] 分类分布：${[...classCounts.entries()].map(([cls, count]) => `${cls}×${count}`).join(" ")}`);
    assert.equal([...classCounts.values()].reduce((total, count) => total + count, 0), WEEKS, "每周都要有明确分类");

    // 2) 无活动周 → missed/severe：真实数据条件断言 + 模板周零活动确定性断言。
    for (const deviation of full) {
      if (deviation.actualKm === 0) {
        assert.equal(deviation.class, "missed", `${deviation.weekStart} 无活动周应为 missed`);
        assert.equal(deviation.severe, true, `${deviation.weekStart} 无活动周应为 severe`);
      }
    }
    const zeroActivity = assessWeek({ weekDoc: weekDocs[0]!, activities: [] });
    assert.equal(zeroActivity.class, "missed");
    assert.equal(zeroActivity.severe, true);
    assert.equal(zeroActivity.preselect, "no_time"); // 严重也不预判受伤
    console.log(`[deviation] 零活动周（模板 W1 确定性）：class=${zeroActivity.class} severe=${zeroActivity.severe} preselect=${zeroActivity.preselect}`);

    // ── 全量导出（ROLL_DUMP=path）──
    if (process.env.ROLL_DUMP) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(process.env.ROLL_DUMP, JSON.stringify({ weekDocs, activities, deviations: full }, null, 1));
      console.log(`dumped -> ${process.env.ROLL_DUMP}`);
    }
    console.log("[deviation] 断言全过 ✅");
  } finally {
    await store.close();
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
