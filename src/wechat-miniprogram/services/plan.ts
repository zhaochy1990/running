// 训练计划服务层 —— 封装「今日」页所需的计划接口。
//
// 数据来源：`GET /api/{user}/plan/weeks/{weekName}`（Go weekly_plan.go 的
// weeklyPlanDetailResponse）。weekName 为上海周目录名 `YYYY-MM-DD_MM-DD`（周一起始）。
// 响应 content 在 content_version==2（结构化）时为
// `{ schema, sessions[], nutrition[], notes_md?, coach_notes? }`。
//
// 鉴权：路径 `{user}` 必须是 JWT sub UUID（与 `/api/users/me` 返回的 `id` 一致），
// 服务端 authorizeUser 会校验路径用户与 token 是否匹配。

import { http } from './request';
import type {
  PlannedNutrition,
  PlannedSession,
  PlanDayRowView,
  PlanSessionRow,
  PlanSessionRowView,
  PlanWeekView,
  TodayNutritionView,
  TodayView,
  TodayWeekDay,
  TodayWorkoutView,
  WeeklyPlanContentStructured,
  WeeklyPlanDetail,
  WorkoutSource,
  WorkoutStep,
  WorkoutStepRest,
} from '../types/plan';
import {
  buildWeekDays,
  shanghaiWeekStart,
  weekFolderName,
  shanghaiToday,
  shanghaiWeekdayLabel,
  weekSubtitle,
} from '../utils/date';
import { fmtDose, fmtHms, fmtKm } from '../utils/format';
import type { CustomWorkoutCard } from '../types/plan';

/** 拉取用户某一周的活跃训练计划。 */
export function getWeeklyPlan(userId: string, weekName: string): Promise<WeeklyPlanDetail> {
  return http.get<WeeklyPlanDetail>(
    `/api/${encodeURIComponent(userId)}/plan/weeks/${encodeURIComponent(weekName)}`,
  );
}

/** 推送计划 session 到用户绑定的手表。target_date 可选，范围 ±7 天。 */
export interface PushPlannedSessionResponse {
  ok: boolean;
  planned_session_id: number;
  scheduled_workout_id: number;
  provider: string;
  provider_workout_id: string;
  push_date: string;
}

export function pushPlannedSession(
  userId: string,
  date: string,
  sessionIndex: number,
  targetDate?: string,
): Promise<PushPlannedSessionResponse> {
  const path = `/api/${encodeURIComponent(userId)}/plan/sessions/${encodeURIComponent(date)}/${sessionIndex}/push`;
  const qs = targetDate ? `?target_date=${encodeURIComponent(targetDate)}` : '';
  return http.post<PushPlannedSessionResponse>(`${path}${qs}`);
}

/** 当前（上海）周的目录名。 */
export function currentWeekName(): string {
  const today = shanghaiToday();
  return weekFolderName(shanghaiWeekStart(today));
}

/** 统一课表投影：某日期段（含过去日期）的三源 active 课次，weekly→custom→watch 排序。 */
export function getPlanSessions(
  userId: string,
  dateFrom: string,
  dateTo: string,
): Promise<{ sessions: PlanSessionRow[] }> {
  const qs = `date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`;
  return http.get<{ sessions: PlanSessionRow[] }>(`/api/users/me/plan/sessions?${qs}`);
}

/** 删除自建课（软删：服务端归档该行）。 */
export function deleteCustomWorkout(userId: string, workoutId: string): Promise<void> {
  return http.delete(`/api/users/me/custom-workouts/${encodeURIComponent(workoutId)}`);
}

/**
 * 保存自建课（devops#587）：save_token 幂等 upsert —— 重放同一 token 更新同一
 * 行（同一 workout_id），软删后重放则新建。卡片双 CTA（保存/推送）都先走它。
 */
export function upsertCustomWorkout(card: CustomWorkoutCard): Promise<PlanSessionRow> {
  return http.post<PlanSessionRow>('/api/users/me/custom-workouts', {
    date: card.date,
    kind: 'run',
    name: card.name,
    summary: card.summary,
    spec: card.spec,
    total_distance_m: card.total_distance_m,
    total_duration_s: card.total_duration_s,
    estimated_dose: card.estimated_dose,
    save_token: card.save_token,
  });
}

/** 推送自建课到手表（未保存先保存的幂等链由调用方保证先后）。 */
export interface PushCustomWorkoutResponse {
  ok: boolean;
  workout_id: string;
  scheduled_workout_id: number;
  provider: string;
  provider_workout_id: string;
  push_date: string;
}

export function pushCustomWorkout(workoutId: string): Promise<PushCustomWorkoutResponse> {
  return http.post<PushCustomWorkoutResponse>(
    `/api/users/me/custom-workouts/${encodeURIComponent(workoutId)}/push`,
  );
}

// ---------------------------------------------------------------------------
// 视图模型构建
// ---------------------------------------------------------------------------

function firstLine(text: string | null | undefined): string {
  if (!text) return '';
  const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** 来源标记文案：weekly 不标（默认），custom「自建」，watch「手表」。 */
function sourceLabelOf(source: WorkoutSource): string {
  if (source === 'custom') return '自建';
  if (source === 'watch') return '手表';
  return '';
}

/** 由统一 workout 行提取今日训练卡片所需字段（devops#586 三源）。 */
function buildWorkoutViewFromRow(
  row: PlanSessionRow | null,
  plan: WeeklyPlanContentStructured | null,
): TodayWorkoutView | null {
  if (!row) return null;

  // Stored spec may lack the discriminator (pre-#584 rows), so dispatch on
  // kind + spec presence instead of the discriminator.
  const isRunning = row.kind === 'run' && row.spec != null;
  // 统一行不携带 session notes；weekly 源回联周计划内容补齐 coach 备注。
  const weeklySession =
    row.source === 'weekly' && row.session_index != null
      ? plan?.sessions?.find(
          (s) => s.date === row.date && s.session_index === row.session_index,
        )
      : null;
  const coachNote =
    firstLine(weeklySession?.notes_md) || firstLine(plan?.coach_notes) || firstLine(plan?.notes_md);

  const intensityBars = isRunning
    ? deriveIntensityBars(
        (row.spec as { blocks: Array<{ steps: WorkoutStep[]; repeat: number }> }).blocks,
      )
    : [];

  // 可推送：weekly 源走 planned-session 端点（需 session_index 定位），
  // custom 源走 custom-workouts/:id/push（devops#587）；watch 源本就来自
  // 手表，不回推。
  const hasSpec =
    row.spec != null &&
    (row.kind === 'run' || row.kind === 'strength') &&
    (row.source === 'custom' ||
      (row.source === 'weekly' && row.session_index != null));

  // 总时长：落库值优先；custom 课常缺 total_duration_s，用配速中值估时兜底
  // （与柱状图同一套估时口径，10-20 用户拍板；不加约等号）。
  const specBlocks = isRunning
    ? (row.spec as { blocks: Array<{ steps: WorkoutStep[]; repeat: number }> }).blocks
    : null;
  const totalDurationText =
    row.total_duration_s != null
      ? fmtHms(row.total_duration_s)
      : specBlocks
        ? fmtHms(estimateWorkoutSeconds(specBlocks))
        : fmtHms(null);
  const stats = [
    { value: fmtKm(row.total_distance_m), label: '距离(公里)' },
    { value: totalDurationText, label: '总时长' },
    { value: fmtDose(row.estimated_dose), label: '训练负荷' },
  ];

  return {
    title: row.name || row.summary || '训练',
    sessionKind: row.kind,
    source: row.source,
    sourceLabel: sourceLabelOf(row.source),
    workoutId: row.workout_id,
    iconPath: row.kind === 'strength'
      ? '/assets/icons/fitness_center.svg'
      : '/assets/icons/directions_run.svg',
    isRunning,
    pushed: row.pushed,
    intensityBars,
    stats,
    coachNote,
    note: firstLine(weeklySession?.notes_md),
    sessionIndex: row.session_index,
    date: row.date,
    deletable: row.source === 'custom',
    hasSpec,
  };
}

/** 由结构化营养提取今日营养卡片所需字段。 */
function buildNutritionView(nutrition: PlannedNutrition | null): TodayNutritionView | null {
  if (!nutrition) return null;

  const targetsTop = [
    { value: integerOrDash(nutrition.kcal_target), label: '目标热量(kcal)' },
    { value: integerOrDash(nutrition.carbs_g), label: '碳水(g)' },
    { value: integerOrDash(nutrition.protein_g), label: '蛋白质(g)' },
  ];
  const targetsBottom = [
    { value: integerOrDash(nutrition.fat_g), label: '脂肪(g)' },
    { value: integerOrDash(nutrition.water_ml), label: '饮水(ml)' },
  ];
  const meals = (nutrition.meals ?? []).map((meal) => ({
    name: meal.name || '餐次',
    timeHint: meal.time_hint || '',
    detail: firstLine(meal.items_md),
    kcal: meal.kcal != null ? `${Math.round(meal.kcal)} kcal` : '—',
  }));

  const note = firstLine(nutrition.notes_md);
  const hasTargets = [...targetsTop, ...targetsBottom].some((t) => t.value !== '—');

  // 无目标值、无餐次、且无建议 = 当天没有饮食安排，整块隐藏（空态也不展示）。
  // 注意：生成计划常只写 notes_md（无量化目标/餐次），此时同样要展示。
  if (meals.length === 0 && !hasTargets && !note) return null;

  return {
    targetsTop,
    targetsBottom,
    hasTargets,
    meals,
    note,
  };
}

function integerOrDash(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}`;
}

/**
 * 由跑课 blocks 生成强度柱状图：高度=强度（0-100），宽度=段估时占比
 * （时间轴——10-20 用户拍板：柱宽编码预计用时、空档宽编码休息时长，严格
 * 真实比例不钳制）。work 段按目标配速/心率做分段线性映射；课内 work 分数
 * 跨度 ≥3 时再相对归一到 [55,95]，保证递进/间歇课的梯度可见。step.rest /
 * 独立休息步为零高度占位（保留槽位形成空档，休息不是训练、不画柱）。
 * 首段淡化为设计稿的 60% 透明度形态。返回最多 16 根柱，超出则均匀采样。
 */
function deriveIntensityBars(
  blocks: Array<{ steps: WorkoutStep[]; repeat: number }>,
): Array<{ pct: number; weight: number; dim: boolean }> {
  type Entry = { pct: number | null; weight: number; fixed?: boolean };
  // 第一遍：课内配速中值均值——无 pace target 的距离段估时兜底
  let paceSum = 0;
  let paceCount = 0;
  for (const block of blocks) {
    for (const step of block.steps) {
      const t = step.target;
      if (t && t.kind === 'pace_s_km' && t.low != null && t.high != null) {
        paceSum += (t.low + t.high) / 2;
        paceCount++;
      }
    }
  }
  const fallbackPace = paceCount > 0 ? paceSum / paceCount : DEFAULT_PACE_S_KM;

  const raw: Entry[] = [];
  const workScores: number[] = [];
  for (const block of blocks) {
    for (let r = 0; r < Math.max(1, block.repeat); r++) {
      for (const step of block.steps) {
        if (step.step_kind === 'rest' || step.step_kind === 'recovery') {
          raw.push({ pct: null, weight: estimateStepSeconds(step, fallbackPace) });
          continue;
        }
        if (step.step_kind === 'warmup' || step.step_kind === 'cooldown') {
          raw.push({
            pct: step.step_kind === 'warmup' ? 35 : 25,
            weight: estimateStepSeconds(step, fallbackPace),
            fixed: true,
          });
          continue;
        }
        workScores.push(stepIntensity(step));
        raw.push({ pct: stepIntensity(step), weight: estimateStepSeconds(step, fallbackPace) });
        if (step.rest) raw.push({ pct: null, weight: estimateRestSeconds(step.rest) });
      }
    }
  }
  if (raw.length === 0) return [];
  // 课内归一：work 分数跨度 ≥3（约 7s/km 配速差）时线性拉伸到 [55,95]，
  // 让梯度可读（递进课的绝对锚分差往往只有 4-6 分，直接显示则柱高几乎齐平）。
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of workScores) {
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  const normalize = (s: number): number => {
    if (hi - lo < 3) return clampPct(s);
    return clampPct(55 + ((s - lo) / (hi - lo)) * 40);
  };
  const sampled = raw.length > 16 ? sampleEvenly(raw, 16) : raw;
  return sampled.map((e, i) => ({
    pct: e.pct === null ? 0 : e.fixed ? clampPct(e.pct) : normalize(e.pct),
    weight: e.weight,
    dim: i === 0,
  }));
}

const DEFAULT_PACE_S_KM = 330; // 无任何配速信息时的估时兜底（5:30/km）
const OPEN_STEP_DEFAULT_S = 300; // open 段（lap 键手动结束）估 5 分钟
const NON_TIME_REST_DEFAULT_S = 90; // manual / hr_bpm 休息估时不可知，示意宽度

/** 段估时（秒，近似可视化用，非精确值）：time_s 直取；distance_m 按目标
 * 配速中值折算（无 pace target 用课内配速均值兜底）；open 估 5 分钟。 */
function estimateStepSeconds(step: WorkoutStep, fallbackPace: number): number {
  if (step.duration.kind === 'time_s' && step.duration.value) return step.duration.value;
  if (step.duration.kind === 'distance_m' && step.duration.value) {
    const t = step.target;
    const pace =
      t && t.kind === 'pace_s_km' && t.low != null && t.high != null ? (t.low + t.high) / 2 : fallbackPace;
    return (step.duration.value / 1000) * pace;
  }
  return OPEN_STEP_DEFAULT_S;
}

/** 步后休息估时：time_s 直取；manual / hr_bpm 结束时机由跑者决定，估时不可知。 */
function estimateRestSeconds(rest: WorkoutStepRest): number {
  if (rest.kind === 'time_s' && rest.value) return rest.value;
  return NON_TIME_REST_DEFAULT_S;
}

/** 整课估时（秒，全量求和不受柱状图采样影响）：落库 total_duration_s 缺失时
 * 的展示兜底（配速中值折算，10-20 用户拍板）。 */
function estimateWorkoutSeconds(
  blocks: Array<{ steps: WorkoutStep[]; repeat: number }>,
): number {
  let paceSum = 0;
  let paceCount = 0;
  for (const block of blocks) {
    for (const step of block.steps) {
      const t = step.target;
      if (t && t.kind === 'pace_s_km' && t.low != null && t.high != null) {
        paceSum += (t.low + t.high) / 2;
        paceCount++;
      }
    }
  }
  const fallbackPace = paceCount > 0 ? paceSum / paceCount : DEFAULT_PACE_S_KM;
  let total = 0;
  for (const block of blocks) {
    for (let r = 0; r < Math.max(1, block.repeat); r++) {
      for (const step of block.steps) {
        total += estimateStepSeconds(step, fallbackPace);
        if (step.rest) total += estimateRestSeconds(step.rest);
      }
    }
  }
  return total;
}

function clampPct(v: number): number {
  return Math.max(10, Math.min(100, Math.round(v)));
}

/** work 段绝对强度分（60-100 启发式）：配速/心率分段线性，区间取中值。 */
function stepIntensity(step: WorkoutStep): number {
  const target = step.target;
  if (!target) return 75;
  if (target.kind === 'hr_bpm') {
    const high = target.high ?? target.low;
    if (high == null) return 75;
    return piecewise(high, [[145, 62], [155, 72], [165, 84], [175, 92], [185, 100]]);
  }
  if (target.kind === 'pace_s_km') {
    const slow = target.low ?? target.high;
    const fast = target.high ?? target.low;
    if (slow == null || fast == null) return 75;
    const mid = (slow + fast) / 2; // 越小越快
    return piecewise(
      mid,
      [
        [180, 100],
        [210, 95],
        [240, 90],
        [270, 85],
        [300, 78],
        [360, 65],
        [420, 55],
      ],
    );
  }
  return 75;
}

/** 分段线性插值：anchors 为 [x, y] 升序点列，x 之外 clamp 到端点 y。 */
function piecewise(x: number, anchors: Array<[number, number]>): number {
  if (x <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i - 1];
    const [x2, y2] = anchors[i];
    if (x <= x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return last[1];
}

function sampleEvenly<T>(arr: T[], count: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (count - 1));
    out.push(arr[idx]);
  }
  return out;
}

/** 组装指定日期（上海 YYYY-MM-DD）的视图模型。无训练/营养时对应字段为 null。 */
export function buildDayView(
  plan: WeeklyPlanDetail | null,
  rows: PlanSessionRow[],
  dateYmd: string,
): TodayView {
  const weekStart = shanghaiWeekStart(dateYmd);
  const weekDays: TodayWeekDay[] = buildWeekDays(dateYmd);
  const subtitle = weekSubtitle(weekStart);
  const month = Number(dateYmd.slice(5, 7));
  const day = Number(dateYmd.slice(8));
  const todayLabel = `${month}月${day}日`;

  const content =
    plan && typeof plan.content === 'object' && plan.content !== null
      ? (plan.content as WeeklyPlanContentStructured)
      : null;

  // 服务端已按 weekly→custom→watch 排序；优先展示可训练的课，否则落到休息行。
  const dayRows = rows.filter((r) => r.date === dateYmd);
  const meaningful = dayRows.find((r) => r.kind !== 'rest' && r.kind !== 'note');
  const workoutRow = meaningful ?? dayRows[0] ?? null;

  const nutrition = content?.nutrition?.find((n) => n.date === dateYmd) ?? null;

  return {
    weekDays,
    weekSubtitle: subtitle,
    todayLabel,
    workout: buildWorkoutViewFromRow(workoutRow, content),
    nutrition: buildNutritionView(nutrition),
  };
}

/** 组装「今天」的视图模型。 */
export function buildTodayView(
  plan: WeeklyPlanDetail | null,
  rows: PlanSessionRow[],
): TodayView {
  return buildDayView(plan, rows, shanghaiToday());
}

// ---------------------------------------------------------------------------
// 计划页视图模型
// ---------------------------------------------------------------------------

function planSessionRow(s: PlannedSession): PlanSessionRowView {
  const title =
    (s.spec && 'name' in s.spec && s.spec.name) ||
    s.summary ||
    (s.kind === 'rest' ? '休息' : s.kind);

  let iconPath = '/assets/icons/schedule.svg';
  if (s.kind === 'run') iconPath = '/assets/icons/directions_run.svg';
  else if (s.kind === 'strength') iconPath = '/assets/icons/fitness_center.svg';
  else if (s.kind === 'rest') iconPath = '/assets/icons/schedule.svg';

  const hasSpec = (s.kind === 'run' || s.kind === 'strength') && s.spec != null;

  return {
    sessionIndex: s.session_index,
    kind: s.kind,
    title,
    note: firstLine(s.notes_md),
    distanceKm: s.total_distance_m != null ? fmtKm(s.total_distance_m) : '',
    duration: fmtHms(s.total_duration_s),
    isRest: s.kind === 'rest',
    iconPath,
    scheduledWorkoutId: s.scheduled_workout_id ?? null,
    hasSpec,
  };
}

function daySummary(sessions: PlannedSession[]): string {
  const meaningful = sessions.filter((s) => s.kind !== 'rest' && s.kind !== 'note');
  if (meaningful.length === 0) return '休息';
  const parts = meaningful.map((s) => {
    if (s.kind === 'strength') return '力量';
    if (s.kind === 'cross') return '交叉';
    return s.total_distance_m != null ? `${(s.total_distance_m / 1000).toFixed(1)}km` : s.kind;
  });
  return parts.join(' · ');
}

/** 组装「计划」页周视图：展开周一到周日，每列列出当天结构化 session。 */
export function buildPlanWeekView(plan: WeeklyPlanDetail | null, anchorYmd: string): PlanWeekView {
  const weekStart = shanghaiWeekStart(anchorYmd);
  const weekDays = buildWeekDays(anchorYmd);
  const content =
    plan && typeof plan.content === 'object' && plan.content !== null
      ? (plan.content as WeeklyPlanContentStructured)
      : null;

  const sessions = content?.sessions ?? [];
  const byDate = new Map<string, PlannedSession[]>();
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }

  const days: PlanDayRowView[] = weekDays.map((w) => {
    const daySessions = (byDate.get(w.date) ?? []).slice().sort(
      (a, b) => a.session_index - b.session_index,
    );
    return {
      date: w.date,
      weekdayLabel: shanghaiWeekdayLabel(w.date),
      dayNumber: w.dayNumber,
      isToday: w.isToday,
      sessions: daySessions.map(planSessionRow),
      summary: daySummary(daySessions),
    };
  });

  const endYmd = weekDays[6]?.date ?? weekStart;
  const weekTitle = `${weekStart.slice(5)} ~ ${endYmd.slice(5)}`;
  return { weekTitle, days };
}
