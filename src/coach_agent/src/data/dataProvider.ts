import type { CalibrationSelection, CalibrationSource } from "./calibrationMetadata.js";
/** Read-only athlete data needed by the Coach Agent. */
export interface DataProvider {
  getUserProfile(userId: string): Promise<UserProfile | null>;
  getUserInjuries(userId: string): Promise<UserInjury[]>;
  getVendorHrvBaseline(userId: string, asOfDay: string): Promise<VendorHrvBaseline | null>;
  getDailyRecoveryByDateRange(userId: string, startDay: string, endDay: string): Promise<DailyRecovery[]>;
  getWeeklyFeedbackByDateRange(userId: string, startDay: string, endDay: string): Promise<WeeklyFeedback[]>;
  getMasterPlanMetadataForDate(userId: string, day: string): Promise<ActiveMasterPlanMetadata | null>;
  /** 区间内活动按 date 升序，不含 `laps`（列表/问答用；避免拉整段分段数据）。 */
  getActivitySummariesByDateRange(userId: string, startDay: string, endDay: string): Promise<Activity[]>;
  /** 全量活动（含 `laps` 分段），供 master/weekly context 等需要完整数据的调用方。 */
  getActivitiesByDateRange(userId: string, startDay: string, endDay: string): Promise<Activity[]>;
  /** 单条运动的完整明细（含 `laps` 分段）；不存在返回 null。列表查询用 getActivitySummariesByDateRange。 */
  getActivityDetail(userId: string, labelId: string, options?: { includeKilometerSplits?: boolean }): Promise<Activity | null>;
  getDailyTrainingLoadByDateRange(userId: string, startDay: string, endDay: string): Promise<DailyTrainingLoad[]>;
  /** 确认为比赛的跑步记录（races 表 ∪ session_class='race'，devops#790），最近在前；`minDistanceKm` 只是噪音地板（默认 4.5km），不做比赛判定。 */
  getRaceHistory(userId: string, options: { asOfDate: string; minDistanceKm?: number; limit?: number }): Promise<RaceEffort[]>;
  getPersonalBests(userId: string, asOfDate: string): Promise<PersonalBest[]>;
  getLatestRunningCalibration(userId: string, asOfDate: string): Promise<RunningCalibration | null>;
  getMasterPlan(userId: string, day: string): Promise<MasterPlanDocument | null>;
  getWeeklyPlan(userId: string, weekName: string): Promise<WeeklyPlanDocument | null>;
  /** 统一训练安排投影（devops#586 三源：weekly/custom/watch active 行），供教练查询某天该练什么。 */
  getPlanSessions(userId: string, dateFrom: string, dateTo: string): Promise<DaySessionRow[]>;
  getRaceTarget(userId: string): Promise<RaceTarget | null>;
  /** 一场赛事的内容聚合（race_calendar + items + race_city_content），供比赛策略；赛事不存在返回 null。 */
  getRaceCalendarContext(raceEventId: number): Promise<RaceCalendarContext | null>;
  /** 已发布赛历检索（devops#812，QA 只读列表）；日期窗缺省 = asofDate 起 90 天。 */
  searchRaceCalendar(options: RaceCalendarSearchQuery): Promise<RaceCalendarSummary[]>;
  /** 运动员成绩基线（race_predictions + ability L4 + running_calibration）的有界聚合。 */
  getPerformanceBaseline(userId: string, asOfDate: string): Promise<PerformanceBaseline>;
  /**
   * 首次同步 session 的覆盖快照（devops#1013）：原始/分析覆盖、as-of、
   * revision、gaps 与 pending/partial/unavailable。无 session 返回 null——
   * 老用户或分阶段同步未开（rollout 默认关），null 绝不能当作「数据不存在」。
   */
  getSyncCoverage(userId: string): Promise<SyncCoverage | null>;
}

/** ── 首次同步覆盖（devops#1013，Go-owned onboarding sync 表的只读投影）── */

/** 就绪级别词汇，与 Go onboardingsync.Readiness 一致（唯一事实源，schema/推导共用）。 */
export const SYNC_READINESS_VALUES = ["not_started", "pending", "running", "ready", "ready_with_gaps", "failed", "partial", "unavailable"] as const;

/** 就绪级别，与 Go onboardingsync.Readiness 词汇一致。 */
export type SyncReadiness = (typeof SYNC_READINESS_VALUES)[number];

/** 一段永久缺口：厂商确认不可获取的区间（上海自然日）。 */
export interface SyncStageGap {
  from: string;
  to: string;
  reason?: string;
}

/** 一个同步阶段的覆盖：target / scanned / observed 分离，gaps 显式列出，readiness 派生不假报。 */
export interface SyncStageCoverage {
  stage: string;
  status: string;
  readiness: SyncReadiness;
  targetFrom: string;
  targetTo: string;
  scannedFrom: string | null;
  scannedTo: string | null;
  observedFrom: string | null;
  observedTo: string | null;
  gaps: SyncStageGap[];
  error: string | null;
}

/** 已发布近期分析结果：真实 as-of、域级可用性、输入 revision（fingerprint）与 stale/refreshing。 */
export interface SyncRecentAnalysis {
  asOfDay: string;
  /** ready | partial | unavailable */
  status: string;
  stale: boolean;
  refreshing: boolean;
  /** {"calibration|load|zones|ability":{"status":..,"reason":..}} */
  domains: Record<string, { status: string; reason?: string }>;
  coverageFrom: string | null;
  coverageTo: string | null;
  /** 输入 revision：as-of + binding revision + 校准策略 + 近期数据摘要的指纹。 */
  inputFingerprint: string;
  computedAt: Date;
}

export interface SyncCoverageReadiness {
  shellReady: boolean;
  recentData: SyncReadiness;
  recentAnalysis: SyncReadiness;
  extendedData: SyncReadiness;
  historicalData: SyncReadiness;
  historicalAnalysis: SyncReadiness;
  auxiliary: SyncReadiness;
}

/** 用户当前（非 superseded）首次同步 session 的覆盖快照；无 session = null。 */
export interface SyncCoverage {
  sessionId: string;
  /** dispatching | running | waiting_legacy | completed | completed_with_gaps | failed */
  state: string;
  provider: string;
  bindingRevision: number;
  /** session 固定的扫描锚定日（上海自然日），与分析 as-of 分开。 */
  anchorDay: string;
  error: string | null;
  stages: SyncStageCoverage[];
  readiness: SyncCoverageReadiness;
  historicalAnalysisReason?: string;
  recentAnalysisDetail: SyncRecentAnalysis | null;
  updatedAt: Date;
}

/** One watch-synced activity. `date` is a UTC instant. */
export interface Activity {
  userId: string;
  labelId: string;
  name: string | null;
  sportName: string | null;
  date: Date;
  /** 活动归属的上海日历日 YYYY-MM-DD（devops#936）：Provider 读数时统一换算，
   * 下游按日分组/过滤一律用本字段，禁止再对 `date` 自行 +8h。 */
  shanghaiDay: string;
  distanceM: number | null;
  durationS: number | null;
  avgPaceSKm: number | null;
  bestKmPace: number | null;
  maxPace: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  maxCadence: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgStepLenCm: number | null;
  ascentM: number | null;
  descentM: number | null;
  /** STRIDE-computed activity dose; null until the STRIDE load pipeline runs. */
  strideDose: number | null;
  /** STRIDE-computed session classification; never a vendor training label. */
  strideSessionClass: string | null;
  temperature: number | null;
  humidity: number | null;
  feelsLike: number | null;
  windSpeed: number | null;
  sportNote: string | null;
  sport: string | null;
  /** 主观体感：厂商归一化 1–10 RPE（Garmin÷10 / COROS×2 后 clamp）；null = 厂商未评。 */
  feel: number | null;
  /** 运动员经教练对话补填的体感原话（自由文本，可分段，如「前面4组体感6，最后两组7-8」）；null = 没说过。 */
  feelNote: string | null;
  verticalOscillationMm: number | null;
  groundContactTimeMs: number | null;
  verticalRatioPct: number | null;
  pauses: unknown | null;
  provider: string;
  /** Per-activity laps/segments; `[]` when the watch did not record any */
  laps: ActivityLap[];
  /** Validated kilometer splits for a single activity detail. */
  kilometerSplits?: ActivityLap[];
}

/** One lap/segment of a watch activity. Field names mirror the `laps` table. */
export interface ActivityLap {
  lapIndex: number;
  lapType: string | null;
  distanceM: number | null;
  durationS: number | null;
  avgPace: number | null;
  adjustedPace: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  ascentM: number | null;
  descentM: number | null;
  exerciseType: number | null;
  exerciseNameKey: string | null;
  mode: number | null;
}

export interface DailyTrainingLoad {
  date: string;
  trainingDose: number;
  acuteLoad: number | null;
  chronicLoad: number | null;
  form: number | null;
  loadRatio: number | null;
  coverageStatus: string;
}
export interface RaceEffort {
  date: string;
  labelId: string;
  name: string | null;
  sport: string | null;
  distanceKm: number | null;
  durationMin: number | null;
  avgPaceSKm: number | null;
  avgHr: number | null;
  maxHr: number | null;
  feel: number | null;
  /** 比赛信号的来源（devops#790）：races=race detection 确认行；sessionClass=分类器 session_class='race'。双命中置信最高。 */
  source?: { races: boolean; sessionClass: boolean };
}
export interface PersonalBest {
  distance: string;
  timeSec: number;
  achievedAt: string | null;
  activityLabelId: string;
}
export interface RunningCalibration {
  calibrationId?: number;
  algorithmVersion?: number;
  computedAt?: string;
  selection?: CalibrationSelection;
  source?: CalibrationSource;
  fingerprint?: string;
  asOfDate: string;
  thresholdHr: number | null;
  thresholdSpeedMps: number | null;
  rhrBaseline: number | null;
  thresholdHrConfidence: string;
  thresholdSpeedConfidence: string;
  heartRateZones: HeartRateZone[];
  paceZones: PaceZone[];
}
export interface HeartRateZone {
  name: string;
  minBpm: number | null;
  maxBpm: number | null;
}
export interface PaceZone {
  name: string;
  minPaceSPerKm: number | null;
  maxPaceSPerKm: number | null;
}
export interface UserProfile {
  userId: string;
  displayName: string | null;
  dob: string | null;
  sex: string | null;
  heightCm: number | null;
  weightKg: number | null;
  runningAgeRange: string | null;
}
export interface VendorHrvBaseline {
  low: number | null;
  high: number | null;
  provider: string;
  date: string;
}
export interface UserInjury {
  description: string;
  recoveryStatus: string;
  runningRestriction: string;
}
export interface DailyRecovery {
  date: string;
  rhr: number | null;
  hrv: number | null;
}
export interface WeeklyFeedback {
  weekStart: string;
  contentMd: string;
  updatedAt: Date;
}
export interface RaceTarget {
  goal_id: string;
  user_id: string;
  status: string;
  race_date: string;
  race_distance: string;
  race_name: string;
  target_finish_time: string;
  weekly_training_days: number;
}
export interface ActiveMasterPlanMetadata {
  planId: string;
  revision: number;
  status: string;
  content: MasterPlanDocument;
}
export type MasterPlanDocument = Record<string, unknown>;
export type WeeklyPlanDocument = Record<string, unknown>;

/** ── 比赛策略上下文（race_calendar / race_calendar_item / race_city_content 镜像）── */

/** storage.RaceElevationPoint 镜像：赛道剖面采样点。 */
export interface RaceElevationPoint {
  distance_km: number;
  elevation_m: number;
}
/** storage.RaceCourseChallenge 镜像：赛道难点（隧道/立交/坡道）。 */
export interface RaceCourseChallenge {
  distance_km: number | null;
  description: string;
}
/** storage.RaceAidStation 镜像：补给站。 */
export interface RaceAidStation {
  distance_km: number;
  supplies: string[];
}
/** storage.RaceCutoff 镜像：关门点（CutoffAt 是比赛日墙钟 HH:MM，不做时区换算）。 */
export interface RaceCutoff {
  point: string;
  distance_km: number | null;
  cutoff_at: string;
}
/** storage.RaceClimate 镜像：赛期气候（JSON 原样透传，字段由 Go 侧定义）。 */
export type RaceClimateJson = Record<string, unknown> | null;

/** storage.RaceReputation 镜像：赛历维护的项目口碑。 */
export interface RaceReputation {
  summary: string;
  pros: string[];
  cons: string[];
}

/** 赛事问答和比赛策略共用的 race_calendar_item 只读字段。 */
export interface RaceCalendarItemContent {
  item_type: string;
  name: string;
  distance_km: number | null;
  start_point: string | null;
  finish_point: string | null;
  route_description: string | null;
  total_ascent_m: number | null;
  elevation_points: RaceElevationPoint[];
  course_challenges: RaceCourseChallenge[];
  reputation: RaceReputation | null;
  aid_stations: RaceAidStation[];
  cutoffs: RaceCutoff[];
  /** item 级内容 provenance（null=管理员录入，"WebSearch"=调研脚本）。 */
  content_source: string | null;
}

/** race_city_content 的内容投影（出行/气候背景）。 */
export interface RaceCityContentBrief {
  city: string;
  overview: string | null;
  food: string | null;
}

/** 一场已发布赛事的内容聚合，包含事件、项目与城市内容。 */
export interface RaceCalendarContext {
  race_event_id: number;
  name: string;
  name_cn: string | null;
  race_date: string;
  province: string | null;
  city: string | null;
  climate: RaceClimateJson;
  /** 事件级内容 provenance；有值=内容经过调研，是策略入口的门槛。 */
  content_source: string | null;
  items: RaceCalendarItemContent[];
  city_content: RaceCityContentBrief | null;
}

/** searchRaceCalendar 的检索条件；`asofDate` 锚定缺省日期窗（实现层补齐）。 */
export interface RaceCalendarSearchQuery {
  asofDate: string;
  /** 名称关键词，子串匹配 name / name_cn。 */
  keyword?: string;
  /** 城市精确匹配（如「杭州市」）。 */
  city?: string;
  /** 比赛日期下界 YYYY-MM-DD（含），缺省 = asofDate。 */
  dateFrom?: string;
  /** 比赛日期上界 YYYY-MM-DD（含），缺省 = dateFrom + 90 天。 */
  dateTo?: string;
  /** 项目类型 token（Marathon / HalfMarathon / Trail / Ultra / {n}Km，与 race_calendar_item.type 同词汇）。 */
  itemType?: string;
  limit?: number;
}

/** race_calendar 检索摘要行：轻量列表投影，赛道等内容明细走 getRaceCalendarContext。 */
export interface RaceCalendarSummary {
  race_event_id: number;
  name: string;
  name_cn: string | null;
  race_date: string;
  province: string | null;
  city: string | null;
  items: Array<{ item_type: string; distance_km: number | null }>;
}

/** workout 表一行的教练查询投影（devops#586 三源统一读面）。 */
export interface DaySessionRow {
  workout_id: string;
  date: string;
  source: "weekly" | "custom" | "watch";
  kind: string;
  name: string;
  summary: string | null;
  /** 规范 spec 原文（run-workout/v1 或 strength-workout/v1）；查询端渲染摘要用。 */
  spec_json: string | null;
  /** custom 行的幂等保存令牌（devops#697 reissue 复用用）；weekly/watch 行为 null。 */
  save_token: string | null;
  /** 已推送到手表（scheduled_workout 有 pushed 行）。 */
  pushed: boolean;
}

/** ability_snapshot L4 行的有界投影（取 as_of 前最近一天的整组）。 */
export interface AbilityL4Baseline {
  as_of_date: string;
  composite: number | null;
  marathon_training_s: number | null;
  marathon_race_s: number | null;
  hm_race_s: number | null;
}

/** race_predictions 一行。 */
export interface RacePredictionRow {
  race_type: string;
  duration_s: number | null;
  avg_pace_s_km: number | null;
}

/** 运动员成绩基线：预测、能力 L4、跑步校准三源聚合（缺项为 null/空数组，由教练声明依据不足）。 */
export interface PerformanceBaseline {
  as_of_date: string;
  race_predictions: RacePredictionRow[];
  ability_l4: AbilityL4Baseline | null;
  running_calibration: RunningCalibration | null;
}
