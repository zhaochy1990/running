import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadPlan, PhaseDivisionIntent, RunWorkout, WeeklyPlan } from "@stride/contract";
import type { ContentWeekRow } from "../master_plan/phasing/content/doctrine.js";
import type { ScheduledOutcome } from "../master_plan/phasing/content/generate.js";
import type { LoadSeriesPoint } from "../master_plan/phasing/content/schedule/scheduler.js";
import { buildWeeklyDocs, freezePastSessions, mergeAdjustedWeekDocs } from "./weeklyDocs.js";

/**
 * 周课文档构造单测（#858）：字段映射 / coach_notes 模板 / 偏差百分比 / rest 日
 * 会话 / 负荷投影 / 追赶冻结。批产物用手工 ScheduledOutcome（结构子集）构造。
 */

const PLAN_START = "2026-10-05"; // 周一
const ZONES = { easy: [288, 336], m: [249, 288], t: [235, 249], i: [218, 235], r: [null, 218] } as const;

function policy8(): PhaseDivisionIntent {
  return {
    phases: [
      {
        canonical: "foundation",
        name: "第一阶段·基础期",
        start_week: 1,
        end_week: 5,
        primary_goal: "aerobic_base",
        training_goal: "建立有氧基础",
        block_mode: "progressive",
        rationale: "赛季初有氧储备不足",
      },
      {
        canonical: "final_quality",
        name: "第四阶段·最终质量期",
        start_week: 6,
        end_week: 8,
        primary_goal: "race_specificity",
        training_goal: "比赛专项",
        block_mode: "plateau",
        rationale: "专项收窄",
      },
    ],
    taper_weeks: 2,
    milestones: [{ phase: "foundation", signal: "周量", criterion: "连续 3 周 ≥60km" }],
    gates: [{ phase: "foundation", signal: "RHR", criterion: "周均 ≤ 基线+3", action_if_missed: "降周 15%" }],
    volume_bands: [
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  };
}

function skeleton(kms: Record<number, number>): LoadPlan {
  return {
    weeks: Object.entries(kms).map(([week, km]) => ({
      week: Number(week),
      canonical: "foundation" as const,
      block: 1,
      role: "progress" as const,
      km,
      lr: 20,
      q: 1,
    })),
    blocks: [{ block: 1, canonical: "foundation", start_week: 1, end_week: 8, absorb_weeks: [], boundary: "phase_start" }],
    recovery_policy: [],
    strength_policy: [],
    checks: [],
    milestones: [],
  };
}

/** key_sessions 用：对指定周覆写 skeleton 周行属性（role/canonical）。 */
function withWeekOverrides(plan: LoadPlan, overrides: Record<number, Partial<LoadPlan["weeks"][number]>>): LoadPlan {
  return { ...plan, weeks: plan.weeks.map((week) => ({ ...week, ...(overrides[week.week] ?? {}) })) };
}

function workout(name: string, date: string, type: RunWorkout["type"], distanceM: number, pace: [number, number]): RunWorkout {
  return {
    schema: "run-workout/v1",
    name,
    date,
    note: null,
    type,
    purpose: `${type} 课`,
    blocks: [
      {
        repeat: 1,
        steps: [
          {
            step_kind: "work",
            duration: { kind: "distance_m", value: distanceM },
            target: { kind: "pace_s_km", low: pace[0], high: pace[1] },
            note: null,
            hr_cap_bpm: null,
          },
        ],
      },
    ],
  };
}

function loadPoints(week: number, weekStart: string): LoadSeriesPoint[] {
  return Array.from({ length: 7 }, (_, offset) => ({
    date: new Date(new Date(`${weekStart}T00:00:00Z`).getTime() + offset * 86_400_000).toISOString().slice(0, 10),
    week,
    loadPt: 10,
    atl: 60,
    ctl: 57,
    ratio: offset === 6 ? 1.05 : 1.0,
    sessions: [],
  }));
}

function scheduledFixture(): ScheduledOutcome {
  const w4 = "2026-10-26"; // 第 4 周周一
  return {
    weeks: [
      {
        week: 4,
        sessions: [workout("T 巡航 5km", "2026-10-27", "T", 5000, [235, 249]), workout("周末长跑 20km", "2026-11-01", "LR", 20000, [288, 336])],
      },
      {
        week: 5,
        sessions: [workout("T 巡航 6km", "2026-11-03", "T", 6000, [235, 249]), workout("周末长跑 22km", "2026-11-08", "LR", 22000, [288, 336])],
      },
    ],
    calendar: [],
    loadSeries: [...loadPoints(4, w4), ...loadPoints(5, "2026-11-02")],
    loadMeta: { model: "exp-pmc-7-42", seed: { acute: 55, chronic: 60, source: "test" }, coefficient_version: "lsq-20261029" },
    checks: [],
    scheduleChecks: [],
    repairs: [],
    source: "llm",
    attempts: 1,
    attemptsDetail: [],
  };
}

const BATCH_ROWS: ContentWeekRow[] = [
  {
    week: 4,
    phase: "foundation",
    role: "progress",
    totalKm: 66,
    longRunKm: 20,
    qualitySessions: 1,
    qualityFamily: "E 为主；速度触感靠 strides 副课",
    zones: ZONES,
  },
  {
    week: 5,
    phase: "foundation",
    role: "progress",
    totalKm: 70,
    longRunKm: 22,
    qualitySessions: 1,
    qualityFamily: "E 为主；速度触感靠 strides 副课",
    zones: ZONES,
  },
];

function buildDocs(scheduled: ScheduledOutcome = scheduledFixture()): WeeklyPlan[] {
  return buildWeeklyDocs({
    scheduled,
    batchRows: BATCH_ROWS,
    policy: policy8(),
    skeletonNew: skeleton({ 1: 50, 2: 55, 3: 60, 4: 66, 5: 70, 6: 72, 7: 68, 8: 64 }),
    skeletonStored: skeleton({ 1: 50, 2: 55, 3: 60, 4: 60, 5: 65, 6: 72, 7: 68, 8: 64 }),
    planStartMonday: PLAN_START,
    raceDate: "2026-11-28",
    athlete: { weeklyRunDaysMax: 6 },
  });
}

test("周文档字段：week_name/周号/阶段/里程碑/目标 km/剂量投影/来源", () => {
  const docs = buildDocs();
  assert.equal(docs.length, 2);
  const [w4, w5] = docs;
  assert.ok(w4 && w5);
  assert.equal(w4.week_name, "2026-10-26_11-01");
  assert.equal(w4.week_index, 4);
  assert.equal(w4.phase_name, "base");
  assert.equal(w4.phase_goal, "建立有氧基础（赛季初有氧储备不足）");
  assert.equal(w4.milestone_note, "周量：连续 3 周 ≥60km");
  assert.equal(w4.target_weekly_km_low, 66);
  assert.equal(w4.target_weekly_km_high, 66);
  assert.equal(w4.is_recovery_week, false);
  assert.equal(w4.planned_dose, 70);
  assert.equal(w4.load_ratio_projection, 1.05);
  assert.equal(w4.source, "llm");
  assert.equal(w4.km_deviation_pct, 10);
  assert.equal(w5.km_deviation_pct, 7.7);
});

test("coach_notes 模板：目标（rationale）；第 N 周（role）；出口里程碑", () => {
  const [w4] = buildDocs();
  assert.ok(w4);
  assert.equal(w4.coach_notes, "建立有氧基础（赛季初有氧储备不足）；第 4 周（progress）；出口里程碑：周量：连续 3 周 ≥60km");
});

test("会话映射：run 会话带估距/时长/dose；无课日补 rest 会话（7 天全覆盖）", () => {
  const [w4] = buildDocs();
  assert.ok(w4);
  const runs = w4.sessions.filter((session) => session.kind === "run");
  const rests = w4.sessions.filter((session) => session.kind === "rest");
  assert.equal(runs.length, 2);
  assert.equal(rests.length, 5);
  assert.equal(w4.sessions.length, 7);
  const t = runs.find((session) => session.summary === "T 巡航 5km");
  assert.ok(t);
  assert.equal(t.total_distance_m, 5000);
  assert.ok((t.estimated_dose ?? 0) > 0, "T 课剂量按带系数核算");
  assert.ok(rests.every((rest) => rest.spec === null && rest.summary === "休息"));
  const dates = w4.sessions.map((session) => session.date).sort();
  assert.deepEqual(
    dates,
    Array.from(
      { length: 7 },
      (_, offset) => dates[0] && new Date(new Date(`${dates[0]}T00:00:00Z`).getTime() + offset * 86_400_000).toISOString().slice(0, 10),
    ),
  );
});

test("final_quality 周经 span 劈分映射到 marathon/taper 阶段名", () => {
  const rows: ContentWeekRow[] = [
    { week: 6, phase: "final_quality", role: "progress", totalKm: 72, longRunKm: 24, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones: ZONES },
    { week: 7, phase: "final_quality", role: "taper", totalKm: 68, longRunKm: 20, qualitySessions: 2, qualityFamily: "M 配速比赛专项", zones: ZONES },
  ];
  const docs = buildWeeklyDocs({
    scheduled: {
      ...scheduledFixture(),
      weeks: [
        { week: 6, sessions: [workout("MP 模拟 30km", "2026-11-15", "LR", 30000, [249, 288])] },
        { week: 7, sessions: [workout("T 触感 8km", "2026-11-22", "T", 8000, [235, 249])] },
      ],
      loadSeries: [...loadPoints(6, "2026-11-09"), ...loadPoints(7, "2026-11-16")],
    },
    batchRows: rows,
    policy: policy8(),
    skeletonNew: skeleton({ 1: 50, 2: 55, 3: 60, 4: 66, 5: 70, 6: 72, 7: 68, 8: 64 }),
    skeletonStored: skeleton({ 1: 50, 2: 55, 3: 60, 4: 60, 5: 65, 6: 72, 7: 68, 8: 64 }),
    planStartMonday: PLAN_START,
    raceDate: "2026-11-28",
    athlete: { weeklyRunDaysMax: 6 },
  });
  assert.equal(docs[0]!.phase_name, "marathon");
  assert.equal(docs[1]!.phase_name, "taper");
  // final_quality 无 L2 出口里程碑时 coach_notes 落「无」，milestone_note 缺省
  assert.match(docs[0]!.coach_notes ?? "", /出口里程碑：无$/);
  assert.equal(docs[0]!.milestone_note, undefined);
});

test("追赶冻结：删除 date < 明天 的会话并注明；整周无未来 run 时移除该周", () => {
  const docs = buildDocs();
  const frozen = freezePastSessions(docs, "2026-10-28T09:00:00+08:00"); // 第 4 周周三
  const [w4, w5] = frozen;
  assert.ok(w4 && w5);
  // 周一/周二/周三已过 → 只剩周四起（周四/周五 rest + 周六 rest + 周日 LR）
  assert.ok(w4.sessions.every((session) => session.date >= "2026-10-29"));
  assert.ok(
    w4.sessions.some((session) => session.kind === "run"),
    "周日 LR 保留",
  );
  assert.match(w4.notes_md ?? "", /本周已过日期未排课/);
  assert.match(w4.notes_md ?? "", /截至 2026-10-28/);
  // 第二周不受影响
  assert.equal(w5.sessions.length, 7);
  assert.equal(w5.notes_md, null);
  // 第 4 周整周都已过（11-01 当天及以前）→ 该周不发布，绝不回退成未冻结文档
  const afterWeek = freezePastSessions(docs, "2026-11-01T09:00:00+08:00");
  assert.deepEqual(
    afterWeek.map((doc) => doc.week_name.slice(0, 10)),
    ["2026-11-02"],
  );
});

// ── key_sessions 派生（#858 PR-C 下半；口径与 v2 快照同源：E 课剔除、赛周只留
//    比赛课、非恢复周 ≤3 / 恢复周 ≤1 按总里程降序截断）─────────────────────────

test("key_sessions：T/LR 课进重点课，E 课剔除；按总里程降序", () => {
  const docs = buildDocs();
  const [w4] = docs;
  assert.ok(w4);
  // 批产物只有 T（5km）+ LR（20km）→ 2 节重点课，LR 在前
  assert.equal(w4.key_sessions?.length, 2);
  assert.equal(w4.key_sessions?.[0]?.type, "long_run");
  assert.equal(w4.key_sessions?.[0]?.distance_km, 20);
  assert.equal(w4.key_sessions?.[1]?.type, "threshold");
  assert.equal(w4.key_sessions?.[1]?.distance_km, 5);
  assert.equal(w4.key_sessions?.[1]?.workout_structure?.name, "T 巡航 5km");
  // 与 v2 快照同构：同一 scheduled 产物的快照周 key_sessions 与周文档一致
});

test("key_sessions 截断：非恢复周 >3 节按里程降序截前 3", () => {
  const docs = buildWeeklyDocs({
    scheduled: {
      ...scheduledFixture(),
      weeks: [
        {
          week: 4,
          sessions: [
            workout("T 巡航 5km", "2026-10-27", "T", 5000, [235, 249]),
            workout("I 间歇 8km", "2026-10-28", "I", 8000, [218, 235]),
            workout("M 轻量 10km", "2026-10-29", "M", 10000, [249, 288]),
            workout("周末长跑 20km", "2026-11-01", "LR", 20000, [288, 336]),
            workout("E 有氧 6km", "2026-10-30", "E", 6000, [288, 336]),
          ],
        },
      ],
      loadSeries: loadPoints(4, "2026-10-26"),
    },
    batchRows: BATCH_ROWS.slice(0, 1),
    policy: policy8(),
    skeletonNew: skeleton({ 1: 50, 2: 55, 3: 60, 4: 66, 5: 70, 6: 72, 7: 68, 8: 64 }),
    skeletonStored: skeleton({ 1: 50, 2: 55, 3: 60, 4: 60, 5: 65, 6: 72, 7: 68, 8: 64 }),
    planStartMonday: PLAN_START,
    raceDate: "2026-11-28",
    athlete: { weeklyRunDaysMax: 6 },
  });
  const [w4] = docs;
  assert.ok(w4);
  // E 剔除后 4 节 → 截前 3（LR 20 > M 10 > I 8；T 5 被截）
  assert.deepEqual(
    w4.key_sessions?.map((session) => `${session.type}:${session.distance_km}`),
    ["long_run:20", "race_pace:10", "interval:8"],
  );
});

test("key_sessions 赛周：只留比赛课（激活课不进）", () => {
  // 第 8 周 = 2026-11-23..2026-11-29（含比赛日 2026-11-28 周六），skeleton 第 8 周 role=race
  const docs = buildWeeklyDocs({
    scheduled: {
      ...scheduledFixture(),
      weeks: [
        {
          week: 8,
          sessions: [
            // 赛周激活课（比赛日前 2 天的轻量 M 课，v3 产物不进 v2 快照口径）
            workout("赛前激活 3km", "2026-11-26", "M", 3000, [249, 288]),
            workout("上海马拉松", "2026-11-28", "M", 42195, [249, 288]),
          ],
        },
      ],
      loadSeries: loadPoints(8, "2026-11-23"),
    },
    batchRows: [{ ...BATCH_ROWS[0]!, week: 8, role: "race" }],
    policy: policy8(),
    skeletonNew: withWeekOverrides(skeleton({ 1: 50, 2: 55, 3: 60, 4: 66, 5: 70, 6: 72, 7: 68, 8: 64 }), { 8: { role: "race" } }),
    skeletonStored: skeleton({ 1: 50, 2: 55, 3: 60, 4: 60, 5: 65, 6: 72, 7: 68, 8: 64 }),
    planStartMonday: PLAN_START,
    raceDate: "2026-11-28",
    athlete: { weeklyRunDaysMax: 6 },
  });
  const [raceWeek] = docs;
  assert.ok(raceWeek);
  assert.equal(raceWeek.week_name.slice(0, 10), "2026-11-23");
  assert.equal(raceWeek.key_sessions?.length, 1);
  assert.equal(raceWeek.key_sessions?.[0]?.type, "race");
  assert.equal(raceWeek.key_sessions?.[0]?.distance_km, 42.2);
});

test("key_sessions 恢复周：≤1 节（只留最长一节）", () => {
  const docs = buildWeeklyDocs({
    scheduled: {
      ...scheduledFixture(),
      weeks: [
        { week: 4, sessions: [workout("T 巡航 5km", "2026-10-27", "T", 5000, [235, 249]), workout("周末长跑 20km", "2026-11-01", "LR", 20000, [288, 336])] },
      ],
      loadSeries: loadPoints(4, "2026-10-26"),
    },
    batchRows: BATCH_ROWS.slice(0, 1),
    policy: policy8(),
    skeletonNew: withWeekOverrides(skeleton({ 1: 50, 2: 55, 3: 60, 4: 30, 5: 70, 6: 72, 7: 68, 8: 64 }), { 4: { canonical: "recovery" } }),
    skeletonStored: skeleton({ 1: 50, 2: 55, 3: 60, 4: 60, 5: 65, 6: 72, 7: 68, 8: 64 }),
    planStartMonday: PLAN_START,
    raceDate: "2026-11-28",
    athlete: { weeklyRunDaysMax: 6 },
  });
  const [w4] = docs;
  assert.ok(w4);
  assert.equal(w4.is_recovery_week, true);
  assert.equal(w4.key_sessions?.length, 1);
  assert.equal(w4.key_sessions?.[0]?.type, "long_run");
});

// ── 调整已有课表的按日合并（#952）：旧文档截至今天保留、明天起替换 ─────────────

function withSummaries(doc: WeeklyPlan, prefix: string): WeeklyPlan {
  return { ...doc, sessions: doc.sessions.map((session) => ({ ...session, summary: `${prefix}-${session.date}` })) };
}

function withNutritionMarker(doc: WeeklyPlan, kcal: number): WeeklyPlan {
  return { ...doc, nutrition: doc.nutrition.map((item) => ({ ...item, kcal_target: kcal })) };
}

function toRest(session: WeeklyPlan["sessions"][number]): WeeklyPlan["sessions"][number] {
  return {
    schema: "plan-session/v1",
    date: session.date,
    session_index: session.session_index,
    kind: "rest",
    summary: "休息",
    notes_md: null,
    total_distance_m: null,
    total_duration_s: null,
    estimated_dose: null,
    spec: null,
  };
}

test("调整合并：周三接受保留周一至周三旧会话，周四起替换，营养/key_sessions 同步", () => {
  const [oldW4, oldW5] = buildDocs();
  const newW4 = withNutritionMarker(withSummaries(oldW4!, "新"), 123);
  const merged = mergeAdjustedWeekDocs([newW4], [oldW4!, oldW5!], "2026-10-28T09:00:00+08:00");
  assert.equal(merged.length, 1);
  const doc = merged[0]!;
  const cutoff = "2026-10-28";
  // 截至今天（含今天）逐字段沿用旧文档；明天起取新文档
  assert.deepEqual(
    doc.sessions.filter((session) => session.date <= cutoff),
    oldW4!.sessions.filter((session) => session.date <= cutoff),
  );
  assert.deepEqual(
    doc.sessions.filter((session) => session.date > cutoff),
    newW4.sessions.filter((session) => session.date > cutoff),
  );
  assert.equal(doc.sessions.find((session) => session.date === cutoff)?.summary, "休息");
  // 营养日期项同样按日合并
  assert.equal(doc.nutrition.find((item) => item.date === cutoff)?.kcal_target, null);
  assert.equal(doc.nutrition.find((item) => item.date === "2026-10-29")?.kcal_target, 123);
  // key_sessions 按日拆分：过去只留 T（10-27），未来只留 LR（11-01）
  assert.deepEqual(
    doc.key_sessions?.map((key) => key.workout_structure?.date),
    ["2026-11-01", "2026-10-27"],
  );
  // 日期 + 索引无重复；notes 说明过去安排沿用
  assert.equal(new Set(doc.sessions.map((session) => `${session.date}:${session.session_index}`)).size, doc.sessions.length);
  assert.match(doc.notes_md ?? "", /沿用原课表/);
});

test("调整合并：隔天接受时保护接受当天及以前的安排", () => {
  const [oldW4] = buildDocs();
  const newW4 = withSummaries(oldW4!, "新");
  // 方案周三生成、周五才同意：周四/周五已成为过去，仍取旧文档
  const [doc] = mergeAdjustedWeekDocs([newW4], [oldW4!], "2026-10-30T09:00:00+08:00");
  assert.ok(doc);
  assert.equal(doc.sessions.find((session) => session.date === "2026-10-29")?.summary, "休息");
  assert.equal(doc.sessions.find((session) => session.date === "2026-10-30")?.summary, "休息");
  assert.match(doc.sessions.find((session) => session.date === "2026-10-31")?.summary ?? "", /^新-/);
});

test("调整合并：周日无明日安排、未来无 run 保留原周文档，历史已结束周不更新", () => {
  const [oldW4] = buildDocs();
  const newW4 = withSummaries(oldW4!, "新");
  // 周日：明天起没有任何安排 → 该周保留原课表（不能回退成新文档）
  assert.deepEqual(mergeAdjustedWeekDocs([newW4], [oldW4!], "2026-11-01T09:00:00+08:00"), [oldW4]);
  // 合并后没有 run：过去旧课全是 rest、未来新课全是 rest → 保留原课表
  const oldNoRun: WeeklyPlan = { ...oldW4!, sessions: oldW4!.sessions.map((session) => (session.date === "2026-10-27" ? toRest(session) : session)) };
  const newNoFutureRun: WeeklyPlan = { ...newW4, sessions: newW4.sessions.map((session) => (session.date === "2026-11-01" ? toRest(session) : session)) };
  assert.deepEqual(mergeAdjustedWeekDocs([newNoFutureRun], [oldNoRun], "2026-10-31T09:00:00+08:00"), [oldNoRun]);
  // 历史已结束周不可被此路径更新
  assert.deepEqual(mergeAdjustedWeekDocs([newW4], [oldW4!], "2026-11-05T09:00:00+08:00"), []);
});

test("调整合并：未来周整周替换（过去无安排可保留）", () => {
  const [, oldW5] = buildDocs();
  const newW5 = withSummaries(oldW5!, "新");
  const [doc] = mergeAdjustedWeekDocs([newW5], [oldW5!], "2026-10-28T09:00:00+08:00");
  assert.ok(doc);
  assert.deepEqual(doc.sessions, newW5.sessions);
  assert.equal(doc.planned_dose, newW5.planned_dose);
});
