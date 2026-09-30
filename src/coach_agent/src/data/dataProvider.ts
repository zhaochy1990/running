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
  getActivityDetail(userId: string, labelId: string): Promise<Activity | null>;
  getDailyTrainingLoadByDateRange(userId: string, startDay: string, endDay: string): Promise<DailyTrainingLoad[]>;
  getRaceHistory(userId: string, options: { asOfDate: string; minDistanceKm?: number; limit?: number }): Promise<RaceEffort[]>;
  getPersonalBests(userId: string, asOfDate: string): Promise<PersonalBest[]>;
  getLatestRunningCalibration(userId: string, asOfDate: string): Promise<RunningCalibration | null>;
  getMasterPlan(userId: string, day: string): Promise<MasterPlanDocument | null>;
  getWeeklyPlan(userId: string, weekName: string): Promise<WeeklyPlanDocument | null>;
  getRaceTarget(userId: string): Promise<RaceTarget | null>;
  /** 一场赛事的内容聚合（race_calendar + items + race_city_content），供比赛策略；赛事不存在返回 null。 */
  getRaceCalendarContext(raceEventId: number): Promise<RaceCalendarContext | null>;
  /** 运动员成绩基线（race_predictions + ability L4 + running_calibration）的有界聚合。 */
  getPerformanceBaseline(userId: string, asOfDate: string): Promise<PerformanceBaseline>;
}

/** One watch-synced activity. `date` is a UTC instant. */
export interface Activity {
  userId: string;
  labelId: string;
  name: string | null;
  sportName: string | null;
  date: Date;
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
  feel: string | null;
  verticalOscillationMm: number | null;
  groundContactTimeMs: number | null;
  verticalRatioPct: number | null;
  pauses: unknown | null;
  provider: string;
  /** Per-activity laps/segments; `[]` when the watch did not record any */
  laps: ActivityLap[];
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
}
export interface PersonalBest {
  distance: string;
  timeSec: number;
  achievedAt: string | null;
  activityLabelId: string;
}
export interface RunningCalibration {
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

/** race_calendar_item 的内容投影（策略只读字段）。 */
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

/** 一场赛事的有界内容聚合：事件行 + 项目内容 + 城市内容，供 race_strategy 子代理。 */
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
