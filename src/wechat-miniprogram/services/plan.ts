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
  TodayNutritionView,
  TodayView,
  TodayWeekDay,
  TodayWorkoutView,
  WeeklyPlanContentStructured,
  WeeklyPlanDetail,
  WorkoutStep,
} from '../types/plan';
import {
  buildWeekDays,
  shanghaiWeekStart,
  weekFolderName,
  shanghaiToday,
  weekSubtitle,
} from '../utils/date';
import { fmtDose, fmtHms, fmtKm } from '../utils/format';

/** 拉取用户某一周的活跃训练计划。 */
export function getWeeklyPlan(userId: string, weekName: string): Promise<WeeklyPlanDetail> {
  return http.get<WeeklyPlanDetail>(
    `/api/${encodeURIComponent(userId)}/plan/weeks/${encodeURIComponent(weekName)}`,
  );
}

/** 当前（上海）周的目录名。 */
export function currentWeekName(): string {
  const today = shanghaiToday();
  return weekFolderName(shanghaiWeekStart(today));
}

// ---------------------------------------------------------------------------
// 视图模型构建
// ---------------------------------------------------------------------------

function firstLine(text: string | null | undefined): string {
  if (!text) return '';
  const line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** 由结构化 session 提取今日训练卡片所需字段。 */
function buildWorkoutView(
  session: PlannedSession | null,
  plan: WeeklyPlanContentStructured | null,
): TodayWorkoutView | null {
  if (!session) return null;

  const isRunning = session.kind === 'run' && session.spec?.schema === 'run-workout/v1';

  const title = (session.spec && 'name' in session.spec && session.spec.name) || session.summary || '训练';
  const coachNote = firstLine(session.notes_md) || firstLine(plan?.coach_notes) || firstLine(plan?.notes_md);

  const intensityBars = isRunning
    ? deriveIntensityBars((session.spec as { blocks: Array<{ steps: WorkoutStep[]; repeat: number }> }).blocks)
    : [];

  const stats = [
    { value: fmtKm(session.total_distance_m), label: '距离(公里)' },
    { value: fmtHms(session.total_duration_s), label: '总时长' },
    { value: fmtDose(trainingDoseOf(session)), label: '训练负荷' },
  ];

  return {
    title,
    sessionKind: session.kind,
    iconPath: '/assets/icons/directions_run.svg',
    isRunning,
    intensityBars,
    stats,
    coachNote,
    note: firstLine(session.notes_md),
  };
}

/** 计算训练负荷展示值：计划 session 本身大概率不带 dose，这里统一返回 null → 展示 '—'，
 * 待后端在会话上补 dose 字段后可移除该占位。 */
function trainingDoseOf(_session: PlannedSession): number | null {
  return null;
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

  return {
    targetsTop,
    targetsBottom,
    meals,
    note: firstLine(nutrition.notes_md),
  };
}

function integerOrDash(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}`;
}

/**
 * 由跑课 blocks 生成强度柱状图（0-100 高度）。
 * 启发式：warmup/recovery/cooldown/rest 给固定低强度，work 段按目标心率/配速映射到
 * 60-95。首段淡化为设计稿的 60% 透明度形态。真实数据有明确区间后应替换为
 * 逐段工作区间映射。返回最多 12 根柱，超出则均匀采样。
 */
function deriveIntensityBars(
  blocks: Array<{ steps: WorkoutStep[]; repeat: number }>,
): Array<{ pct: number; dim: boolean }> {
  const raw: number[] = [];
  for (const block of blocks) {
    for (let r = 0; r < Math.max(1, block.repeat); r++) {
      for (const step of block.steps) {
        const pct = stepIntensity(step);
        raw.push(pct);
      }
    }
  }
  if (raw.length === 0) return [];
  const sampled = raw.length > 12 ? sampleEvenly(raw, 12) : raw;
  return sampled.map((pct, i) => ({ pct, dim: i === 0 }));
}

function stepIntensity(step: WorkoutStep): number {
  const kind = step.step_kind;
  if (kind === 'rest') return 10;
  if (kind === 'cooldown') return 25;
  if (kind === 'warmup') return 35;
  if (kind === 'recovery') return 45;

  // work（或未知类型）：按目标区间映射
  const target = step.target;
  if (!target) return 75;
  if (target.kind === 'hr_bpm') {
    const high = target.high ?? target.low;
    if (high == null) return 75;
    if (high >= 175) return 95;
    if (high >= 165) return 85;
    if (high >= 150) return 75;
    return 65;
  }
  if (target.kind === 'pace_s_km') {
    const low = target.low ?? target.high; // 更快 = 更小秒值 = 更高强度
    if (low == null) return 75;
    if (low <= 240) return 95;
    if (low <= 300) return 85;
    if (low <= 360) return 75;
    return 65;
  }
  return 75;
}

function sampleEvenly(arr: number[], count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (count - 1));
    out.push(arr[idx]);
  }
  return out;
}

/** 组装指定日期（上海 YYYY-MM-DD）的视图模型。无训练/营养时对应字段为 null。 */
export function buildDayView(plan: WeeklyPlanDetail | null, dateYmd: string): TodayView {
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

  let workoutSession: PlannedSession | null = null;
  if (content && Array.isArray(content.sessions)) {
    const daySessions = content.sessions.filter((s) => s.date === dateYmd);
    const pushable = daySessions.find((s) => s.kind === 'run' || s.kind === 'strength');
    const anyNotRest = daySessions.find((s) => s.kind !== 'rest' && s.kind !== 'note');
    workoutSession = pushable ?? anyNotRest ?? null;
  }

  const nutrition = content?.nutrition?.find((n) => n.date === dateYmd) ?? null;

  return {
    weekDays,
    weekSubtitle: subtitle,
    todayLabel,
    workout: buildWorkoutView(workoutSession, content),
    nutrition: buildNutritionView(nutrition),
  };
}

/** 组装「今天」的视图模型。 */
export function buildTodayView(plan: WeeklyPlanDetail | null): TodayView {
  return buildDayView(plan, shanghaiToday());
}
