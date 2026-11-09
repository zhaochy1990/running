/**
 * 首期课表快照（v2 形状）组装（devops#803 spec §2）。
 *
 * v3 落库内容 = 政策包四段 + **v2 字段全保留**：后者是给存量读方（小程序
 * training-plan 页 / Go 写路径 / 卡片信封）看的那份视图，形态必须是
 * `MasterPlanSchema` 那套（phases + weeks + key_sessions），而 L2/L3/L4 的产物
 * 是另一套（intent 五值 canonical / 周骨架 km-lr-q / run-workout 集合）。本文件
 * 只做两套之间的机械投影，不做任何训练学判断——判断已经在 L2/L3/L4 里做完了。
 *
 * 两处刻意的不一致（都是新链路对旧契约的合理收窄，反过来把旧契约套在新产物上
 * 会崩）：
 * 1. 赛周只保留比赛课，**不投影激活课**：v2 契约要求赛周激活 10-15km@比赛配速
 *    （#585 时代口径），而 L4 自 #809/#55125aae 起是 1.6-3km 短激活（原书
 *    Phase 4 形态）。投影成 v2 会被旧规则判违规，激活课的真实处方仍在
 *    skeleton + scheduled 产物（v3 读方看那份）。
 * 2. final_quality 按 `taper_weeks` 劈成 v2 的 marathon + taper 两个阶段：
 *    v2 有独立 taper 阶段名，L2 把 taper 当 final_quality 的属性。
 */
import {
  type LoadPlan,
  type MasterPlan,
  type MasterPlanGraphRequest,
  type PhaseDivisionIntent,
  type RunWorkout,
  addDays,
  estimatedTotalDistanceM,
  normalizeRunWorkout,
  workoutTotals,
} from "@stride/contract";
import type { ScheduledOutcome } from "./phasing/content/generate.js";

/** L2 canonical → v2 阶段名（v2 枚举冻结在 base/build/speed/marathon/taper/recovery）。 */
const V2_PHASE_NAME: Record<PhaseDivisionIntent["phases"][number]["canonical"], MasterPlan["phases"][number]["name"]> = {
  recovery: "recovery",
  foundation: "base",
  early_quality: "build",
  transition_quality: "speed",
  final_quality: "marathon",
};

/** run-workout 的 `type` → v2 key_session `type`；E 不是「重点课」，不进 key_sessions。 */
const KEY_SESSION_TYPE: Record<NonNullable<RunWorkout["type"]>, MasterPlan["weeks"][number]["key_sessions"][number]["type"] | null> = {
  E: null,
  M: "race_pace",
  T: "threshold",
  I: "interval",
  R: "interval",
  LR: "long_run",
};

export interface SnapshotInput {
  policy: PhaseDivisionIntent;
  skeleton: LoadPlan;
  scheduled: ScheduledOutcome;
  request: MasterPlanGraphRequest;
  /** 第 1 周周一（= policy 第 1 周起点）。 */
  planStartMonday: string;
  /** 生成时点（UTC ISO，写进 created_at/updated_at）。 */
  generatedAt: string;
}

const weekStart = (monday: string, week: number): string => addDays(monday, (week - 1) * 7);
const weekEnd = (monday: string, week: number): string => addDays(weekStart(monday, week), 6);

type V2KeySession = MasterPlan["weeks"][number]["key_sessions"][number];

/** 单个 run-workout → v2 key_session；E 课与无法归类的返回 null。 */
function toKeySession(workout: RunWorkout, raceDate: string, easyPace: number | null): V2KeySession | null {
  const type = workout.date === raceDate ? "race" : workout.type ? KEY_SESSION_TYPE[workout.type] : null;
  if (type === null) return null;
  const totals = workoutTotals(workout);
  const distanceM = totals.total_distance_m ?? estimatedTotalDistanceM(workout, easyPace);
  return {
    type,
    distance_km: distanceM === null ? null : Math.round(distanceM / 100) / 10,
    duration_min: totals.total_duration_s === null ? null : Math.round(totals.total_duration_s / 60),
    intensity: `${workout.type === "LR" ? "长跑" : `${workout.type} 配速课`}：${workout.name}`,
    purpose: workout.purpose ?? null,
    workout_structure: normalizeRunWorkout(workout),
  };
}

export function buildV2Snapshot(input: SnapshotInput): MasterPlan {
  const { policy, skeleton, scheduled, request, planStartMonday, generatedAt } = input;
  const goal = request.goals.find((item) => item.priority === "A") ?? request.goals[0]!;
  const raceDate = goal.race_date;
  const totalWeeks = Math.max(...policy.phases.map((phase) => phase.end_week));
  const sessionsByWeek = new Map(scheduled.weeks.map((week) => [week.week, week.sessions]));
  const easyPace = easyPaceOf(scheduled);

  // 阶段区间：final_quality 按 taper_weeks 劈成 marathon + taper 两段。
  const sorted = [...policy.phases].sort((a, b) => a.start_week - b.start_week);
  const spans = sorted.flatMap((phase) => {
    const taperStart =
      phase.canonical === "final_quality" ? Math.max(phase.start_week, phase.end_week - policy.taper_weeks + 1) : null;
    if (taperStart === null) return [{ phase, name: V2_PHASE_NAME[phase.canonical], start: phase.start_week, end: phase.end_week }];
    return [
      ...(taperStart > phase.start_week
        ? [{ phase, name: V2_PHASE_NAME[phase.canonical], start: phase.start_week, end: taperStart - 1 }]
        : []),
      { phase, name: "taper" as const, start: taperStart, end: phase.end_week },
    ];
  });
  const phaseNameOfWeek = new Map<number, MasterPlan["weeks"][number]["phase_name"]>();
  for (const span of spans) for (let week = span.start; week <= span.end; week += 1) phaseNameOfWeek.set(week, span.name);

  const phases: MasterPlan["phases"] = spans.map((span) => {
    const weeks = skeleton.weeks.filter((week) => week.week >= span.start && week.week <= span.end);
    const band = policy.volume_bands.find((item) => item.phase === span.phase.name);
    const km = weeks.map((week) => week.km);
    const sessions = weeks.flatMap((week) => sessionsByWeek.get(week.week) ?? []);
    return {
      name: span.name,
      start_date: weekStart(planStartMonday, span.start),
      end_date: weekEnd(planStartMonday, span.end),
      focus: `${span.phase.training_goal}（${span.phase.rationale}）`,
      weekly_distance_km_low: band?.weekly_km_min ?? Math.min(...km, 0),
      weekly_distance_km_high: band?.weekly_km_max ?? Math.max(...km, 0),
      key_session_types: [
        ...new Set(sessions.map((workout) => toKeySession(workout, raceDate, easyPace)?.type).filter((type) => type != null)),
      ],
      milestones: phaseMilestones(
        policy.milestones.filter((milestone) => milestone.phase === span.phase.name),
        weekEnd(planStartMonday, span.end),
        raceDate,
        weekStart(planStartMonday, span.start),
        weekEnd(planStartMonday, span.end),
      ),
      key_workouts: [...new Set(sessions.map((workout) => workout.name))].join("；") || "以有氧课为主",
      monitoring_triggers: policy.gates
        .filter((gate) => gate.phase === span.phase.name)
        .map((gate) => `${gate.signal}：${gate.criterion}`),
      coach_note: `${span.phase.training_goal}；块模式 ${span.phase.block_mode}。`,
      strength: {
        sessions_per_week: request.availability.strength_sessions_per_week,
        focus: skeleton.strength_policy.find((item) => item.canonical === span.phase.canonical)?.strength_focus ?? "基础力量与稳定性",
        timing: request.availability.strength_available_days.length
          ? request.availability.strength_available_days.join("、")
          : "每周两次，避开质量课",
      },
      recovery: {
        focus: "睡眠与恢复日优先",
        sleep_target_hours: "8",
        adjustment_trigger: skeleton.recovery_policy[0]?.trigger ?? "体感或静息心率异常升高时降周",
      },
      is_completed: false,
      summary: null,
    };
  });

  const weeks: MasterPlan["weeks"] = skeleton.weeks.map((week) => {
    const isRaceWeek = week.role === "race";
    const keySessions = (sessionsByWeek.get(week.week) ?? [])
      .map((workout) => toKeySession(workout, raceDate, easyPace))
      .filter((session) => session != null)
      // 赛周只留比赛课（激活课是 v3 产物，见文件头注释 1）
      .filter((session) => !isRaceWeek || session.type === "race")
      // v2 兼容快照上限（常规 ≤3/恢复 ≤1）：C3 的 q+1 轻量 M 段位会让一周出现
      // 2Q+轻量课+LR=4 节（2026-11-09 分批复验实证）——按总里程降序截前 N，被截
      // 的课只在 v3 content 里（v2 是兼容投影非全量），audit 与 weekly 投影不受影响。
      .sort((a, b) => (b?.distance_km ?? 0) - (a?.distance_km ?? 0))
      .slice(0, week.canonical === "recovery" ? 1 : 3);
    return {
      week_index: week.week,
      week_start: weekStart(planStartMonday, week.week),
      phase_name: phaseNameOfWeek.get(week.week) ?? V2_PHASE_NAME[week.canonical],
      target_weekly_km_low: week.km,
      target_weekly_km_high: week.km,
      key_sessions: keySessions,
      // v2 的 recovery 周语义 = 无质量课的再生周（契约限制 ≤1 节重点课）。
      // L3 的 absorb 周是 3+1 的降量周、仍带质量课，映射成 recovery 会被
      // MasterPlanSchema 判违规（2026-11-08 真模型首跑实证）。
      is_recovery_week: week.canonical === "recovery",
    };
  });

  return {
    status: "draft",
    goal: {
      race_name: goal.race_name,
      distance: goal.distance,
      race_date: goal.race_date,
      target_time: goal.target_time ?? "finish_only",
      timezone: "Asia/Shanghai",
      location: goal.location ?? null,
    },
    start_date: weekStart(planStartMonday, 1),
    end_date: weekEnd(planStartMonday, totalWeeks),
    total_weeks: totalWeeks,
    phases,
    weeks,
    training_principles: [
      ...sorted.map((phase) => `${phase.name}（W${phase.start_week}-W${phase.end_week}）：${phase.training_goal}`),
      "质量课隔日安排，长跑前一日轻量或休息",
      "补给与营养按比赛日方案演练（碳水、电解质、胶）",
    ],
    generated_by: "coach_agent",
    version: 1,
    created_at: generatedAt,
    updated_at: generatedAt,
  };
}

/** 阶段里程碑：L2 出口里程碑 + （落在该段内的）比赛日。 */
function phaseMilestones(
  own: PhaseDivisionIntent["milestones"],
  endDate: string,
  raceDate: string,
  startDate: string,
  phaseEndDate: string,
): MasterPlan["phases"][number]["milestones"] {
  const milestones: MasterPlan["phases"][number]["milestones"] = own.map((milestone) => ({
    type: "test_run",
    date: endDate,
    target: `${milestone.signal}：${milestone.criterion}`,
    completed_actual: null,
  }));
  if (raceDate >= startDate && raceDate <= phaseEndDate)
    milestones.push({ type: "race", date: raceDate, target: "目标比赛", completed_actual: null });
  return milestones;
}

/** E 课实测配速（估距兜底用）；没有任何带距离+时长的 E 课时为 null。 */
function easyPaceOf(scheduled: ScheduledOutcome): number | null {
  for (const week of scheduled.weeks) {
    for (const workout of week.sessions) {
      if (workout.type !== "E") continue;
      const totals = workoutTotals(workout);
      if (totals.total_distance_m && totals.total_duration_s)
        return Math.round(totals.total_duration_s / (totals.total_distance_m / 1000));
    }
  }
  return null;
}
