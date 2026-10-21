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

export interface WorkoutStepRest {
  kind: 'time_s' | 'hr_bpm' | 'manual';
  value: number | null;
}

export interface WorkoutStep {
  step_kind: StepKind;
  duration: { kind: string; value: number | null };
  target: WorkoutTarget;
  note: string | null;
  hr_cap_bpm?: number | null;
  /** 步后休息（devops#520 D2 新 idiom，work 步可携带） */
  rest?: WorkoutStepRest;
}

export interface NormalizedRunWorkout {
  /** 判别符；#584 前落库内容被剥离，读旧数据时缺失，故可选 */
  schema?: 'run-workout/v1';
  name: string;
  date: string;
  note: string | null;
  blocks: Array<{ steps: WorkoutStep[]; repeat: number }>;
}

export interface NormalizedStrengthWorkout {
  /** 判别符；#584 前落库内容被剥离，读旧数据时缺失，故可选 */
  schema?: 'strength-workout/v1';
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
  /** canonical schema 含此 session 级字段；旧数据可能缺失 */
  estimated_dose?: number | null;
  /** legacy：#584 起落库即剥离此键，仅历史残留数据带值 */
  scheduled_workout_id?: number | null;
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
// 统一课表（devops#586）：GET /api/users/me/plan/sessions 三源投影
// ---------------------------------------------------------------------------

export type WorkoutSource = 'weekly' | 'custom' | 'watch';

/**
 * 教练自建课卡片（devops#587，$type: custom-workout）：save_token 是幂等保存键
 * （POST /api/users/me/custom-workouts upsert），totals/dose 由后端确定性补齐。
 * 与 @stride/contract CustomWorkoutCardSchema 镜像（仓内惯例：手工镜像）。
 */
export interface CustomWorkoutCard {
  save_token: string;
  /** 上海本地 YYYY-MM-DD */
  date: string;
  name: string;
  summary: string;
  advice?: string;
  total_distance_m: number | null;
  total_duration_s: number | null;
  estimated_dose: number | null;
  spec: NormalizedRunWorkout;
}

/** 统一 workout 行：某天要练什么的一次性投影（仅 active，按 weekly→custom→watch 排序） */
export interface PlanSessionRow {
  workout_id: string;
  /** 上海本地 YYYY-MM-DD */
  date: string;
  source: WorkoutSource;
  kind: SessionKind;
  name: string;
  summary: string | null;
  spec: NormalizedRunWorkout | NormalizedStrengthWorkout | null;
  total_distance_m: number | null;
  total_duration_s: number | null;
  /** #526 渐进口径：weekly 计划估计值 / custom 落库值 / watch null */
  estimated_dose: number | null;
  /** 仅 weekly 源携带（plan lineage） */
  session_index: number | null;
  plan_id: string | null;
  provider: string | null;
  provider_entity_id: string | null;
  /** 已推送到手表（scheduled_workout 有 pushed 行；custom 按 workout_id、weekly 按日期+序号匹配） */
  pushed: boolean;
  /** custom 行的幂等令牌（=教练卡片信封 save_token），聊天卡刷新后对账用 */
  save_token: string | null;
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
  /** 段估时（秒）——驱动 flex-grow 宽度（时间轴比例），休息空档同样占权 */
  weight: number;
  /** 首段淡化（对应设计稿首段 60% 透明度） */
  dim: boolean;
}

export interface TodayWorkoutView {
  title: string;
  sessionKind: SessionKind;
  /** 来源标记：weekly 不标，custom「自建」，watch「手表」 */
  source: WorkoutSource;
  sourceLabel: string;
  /** 统一 workout 行 ID（删除自建课用） */
  workoutId: string;
  /** 视觉图标路径 */
  iconPath: string;
  /** 默认 false；非 run/strength 时不显示强度柱状图 */
  isRunning: boolean;
  /** 已推送到手表——手表图标高亮 */
  pushed: boolean;
  intensityBars: ViewIntensityBar[];
  stats: ViewStat[];
  coachNote: string;
  note: string;
  /** session 在当天的索引，用于推送 API；仅 weekly 源有值 */
  sessionIndex: number | null;
  /** session 所属日期 YYYY-MM-DD */
  date: string;
  /** 是否为自建课（可删除） */
  deletable: boolean;
  /** 是否有完整 spec 可推送到手表（仅 weekly 源的 run/strength） */
  hasSpec: boolean;
  /** 是否有可渲染的结构（spec 非空且为 run/strength）——课表详情入口 */
  hasStructure: boolean;
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
  /** 有任一量化目标（热量/碳水/蛋白/脂肪/饮水）时才渲染指标区 */
  hasTargets: boolean;
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
  /** 关联的已排课训练 ID，null 表示未推送 */
  scheduledWorkoutId: number | null;
  /** 是否有完整 spec 可推送到手表（run/strength 且 spec 非空） */
  hasSpec: boolean;
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
