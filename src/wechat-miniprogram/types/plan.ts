// 训练计划 wire 类型 —— 与后端 `src/stride_core/plan_spec.py` / `workout_spec.py`
// 的 `to_dict()` 输出、以及 Web 端 `frontend/src/types/plan.ts` 保持契约一致。
// 小程序端只需要「今日」页用到的最小字段子集，这里做成可空类型，避免后端字段
// 漂移时把整页炸掉。

// ---------------------------------------------------------------------------
// workout_spec 原语（今日页用到的部分）
// ---------------------------------------------------------------------------

export type StepKind = 'warmup' | 'work' | 'recovery' | 'cooldown' | 'rest';

export interface WorkoutTarget {
  kind: 'pace_s_km' | 'hr_bpm' | 'power_w' | 'open';
  low: number | null;
  high: number | null;
}

export interface WorkoutStep {
  step_kind: StepKind;
  duration: { kind: string; value: number | null };
  target: WorkoutTarget;
  note: string | null;
  hr_cap_bpm?: number | null;
}

export interface NormalizedRunWorkout {
  schema: 'run-workout/v1';
  name: string;
  date: string;
  note: string | null;
  blocks: Array<{ steps: WorkoutStep[]; repeat: number }>;
}

export interface NormalizedStrengthWorkout {
  schema: 'strength-workout/v1';
  name: string;
  date: string;
  note: string | null;
  exercises: Array<{
    canonical_id: string;
    display_name: string;
    sets: number;
    target_kind: 'reps' | 'time_s';
    target_value: number;
    rest_seconds: number;
    note: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// plan_spec:PlannedSession / PlannedNutrition（content.sessions / content.nutrition）
// ---------------------------------------------------------------------------

export type SessionKind = 'run' | 'strength' | 'rest' | 'cross' | 'note';

export interface PlannedSession {
  /** 上海本地 YYYY-MM-DD */
  date: string;
  session_index: number;
  kind: SessionKind;
  summary: string;
  spec: NormalizedRunWorkout | NormalizedStrengthWorkout | null;
  notes_md: string | null;
  total_distance_m: number | null;
  total_duration_s: number | null;
  scheduled_workout_id: number | null;
}

export interface PlannedMeal {
  name: string;
  time_hint: string | null;
  kcal: number | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  items_md: string | null;
}

export interface PlannedNutrition {
  date: string;
  kcal_target: number | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  water_ml: number | null;
  meals: PlannedMeal[];
  notes_md: string | null;
}

export interface WeeklyPlanContentStructured {
  schema?: string;
  sessions: PlannedSession[];
  nutrition: PlannedNutrition[];
  notes_md?: string | null;
  coach_notes?: string | null;
}

// ---------------------------------------------------------------------------
// Go weekly_plan.go `weeklyPlanDetailResponse` —— GET /api/{user}/plan/weeks/{weekName}
// ---------------------------------------------------------------------------

export interface WeeklyPlanDetail {
  plan_id: string;
  week_name: string;
  date_from: string;
  date_to: string;
  master_plan_id?: string | null;
  status: string;
  content_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
  /** content_version === 2 时为结构化对象；content_version === 1 时为 markdown 字符串 */
  content?: WeeklyPlanContentStructured | string;
}

// ---------------------------------------------------------------------------
// 今日页视图模型（展示就绪，非 wire 形状）
// ---------------------------------------------------------------------------

export interface ViewStat {
  value: string;
  label: string;
}

export interface ViewIntensityBar {
  /** 0-100，相对图表容器高度 */
  pct: number;
  /** 首段淡化（对应设计稿首段 60% 透明度） */
  dim: boolean;
}

export interface TodayWorkoutView {
  title: string;
  sessionKind: SessionKind;
  /** 视觉图标路径 */
  iconPath: string;
  /** 默认 false；非 run/strength 时不显示强度柱状图 */
  isRunning: boolean;
  intensityBars: ViewIntensityBar[];
  stats: ViewStat[];
  coachNote: string;
  note: string;
}

export interface TodayMealView {
  name: string;
  timeHint: string;
  detail: string;
  kcal: string;
}

export interface TodayNutritionView {
  targetsTop: ViewStat[];
  targetsBottom: ViewStat[];
  meals: TodayMealView[];
  note: string;
}

export interface TodayWeekDay {
  date: string;
  label: string;
  dayNumber: number;
  isToday: boolean;
}

export interface TodayView {
  weekDays: TodayWeekDay[];
  weekSubtitle: string;
  todayLabel: string;
  workout: TodayWorkoutView | null;
  nutrition: TodayNutritionView | null;
}

// ---------------------------------------------------------------------------
// 「计划」周视图模型
// ---------------------------------------------------------------------------

export interface PlanSessionRowView {
  sessionIndex: number;
  kind: SessionKind;
  title: string;
  note: string;
  distanceKm: string;
  duration: string;
  isRest: boolean;
  iconPath: string;
}

export interface PlanDayRowView {
  date: string;
  weekdayLabel: string;
  dayNumber: number;
  isToday: boolean;
  sessions: PlanSessionRowView[];
  summary: string;
}

export interface PlanWeekView {
  weekTitle: string;
  days: PlanDayRowView[];
}
