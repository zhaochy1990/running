import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoadPlan, PhaseDivisionIntent, RunWorkout, WeeklyPlan } from "@stride/contract";
import type { ContentWeekRow } from "../master_plan/phasing/content/doctrine.js";
import type { ScheduledOutcome } from "../master_plan/phasing/content/generate.js";
import type { LoadSeriesPoint } from "../master_plan/phasing/content/schedule/scheduler.js";
import { buildWeeklyDocs, freezePastSessions } from "./weeklyDocs.js";

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
    athlete: { weeklyRunDaysMax: 6 },
  });
  assert.equal(docs[0]!.phase_name, "marathon");
  assert.equal(docs[1]!.phase_name, "taper");
  // final_quality 无 L2 出口里程碑时 coach_notes 落「无」，milestone_note 缺省
  assert.match(docs[0]!.coach_notes ?? "", /出口里程碑：无$/);
  assert.equal(docs[0]!.milestone_note, undefined);
});

test("追赶冻结：删除 date < 明天 的会话并注明；无 run 残留的周保留原样（防御）", () => {
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
});
