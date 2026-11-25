// 训练负荷 / 健康 wire 类型 —— 与后端 /api/{user}/stride/training-load 响应一致。

export interface StrideTrainingLoadRecord {
  date: string;
  algorithm_version: number;
  training_dose: number | null;
  acute_load: number | null;
  chronic_load: number | null;
  form: number | null;
  load_ratio: number | null;
  coverage_status: string;
  readiness_gate: string | null;
  readiness_reasons: string[];
}

export interface StrideTrainingLoadResponse {
  current: StrideTrainingLoadRecord | null;
  series: StrideTrainingLoadRecord[];
}

// ---------------------------------------------------------------------------
// /api/{user}/health —— 每日健康记录 + HRV 快照 + RHR 基线
// 契约与 Web 端 frontend/src/api.ts 的 HealthRecord / HRVSnapshot 保持一致。
// ---------------------------------------------------------------------------

export interface HealthRecord {
  /** 上海 YYYY-MM-DD（或 YYYYMMDD，Web 端两种都兼容） */
  date: string;
  ati: number | null;
  cti: number | null;
  rhr: number | null;
  distance_m: number | null;
  duration_s: number | null;
  training_load_ratio: number | null;
  training_load_state: string | null;
  fatigue: number | null;
  body_battery_high: number | null;
  body_battery_low: number | null;
  stress_avg: number | null;
  sleep_total_s: number | null;
  sleep_deep_s: number | null;
  sleep_light_s: number | null;
  sleep_rem_s: number | null;
  sleep_awake_s: number | null;
  sleep_score: number | null;
  respiration_avg: number | null;
  spo2_avg: number | null;
  provider: string | null;
}

export interface HRVSnapshot {
  avg_sleep_hrv: number | null;
  /** 用户级 HRV 正常区间下限/上限（稳定 baseline，区别于逐日 band） */
  hrv_normal_low: number | null;
  hrv_normal_high: number | null;
  recovery_pct: number | null;
  /** 最近一次 daily_hrv 读数的日期；无任何记录时为 null */
  date: string | null;
}

export interface HealthResponse {
  calibration?: CalibrationMetadata;
  health: HealthRecord[];
  hrv: HRVSnapshot;
  rhr_baseline: number | null;
}

// ---------------------------------------------------------------------------
// /api/{user}/hrv —— 逐日 HRV 记录
// ---------------------------------------------------------------------------

export interface HrvDailyRecord {
  date: string;
  weekly_avg: number | null;
  last_night_avg: number | null;
  last_night_5min_high: number | null;
  status: string | null;
  baseline_low_upper: number | null;
  /** 手表上报的逐日平衡带（区别于用户级 hrv_normal_* baseline） */
  daily_balanced_low: number | null;
  daily_balanced_upper: number | null;
  feedback_phrase: string | null;
  provider: string | null;
}

export interface HrvSummary {
  date: string | null;
  last_night_avg: number | null;
  weekly_avg: number | null;
  status: string | null;
  daily_balanced_low: number | null;
  daily_balanced_upper: number | null;
}

export interface HrvResponse {
  hrv: HrvDailyRecord[];
  summary: HrvSummary;
}

// ---------------------------------------------------------------------------
// /api/{user}/stride/zones —— STRIDE 自研阈值 + 6 档配速/心率区间
// 契约与 Web 端 frontend/src/api.ts 的 StrideZonesResponse 保持一致。
// ---------------------------------------------------------------------------

/** Calibration metadata is optional for old servers. Dates are Shanghai civil
 * days; computed_at is a separate UTC execution instant. Ranges are support or
 * sensitivity bounds, not a 95% confidence interval. */
export interface CalibrationSelection {
  mode: "active" | "candidate";
  policy_revision: number;
  requested_version: number | null;
  effective_version: number | null;
  state: "selected" | "fallback" | "unavailable";
  reason?: string;
  /** #999：该读存在按用户覆盖时披露 pin 身份；缺省表示无覆盖。 */
  override?: {
    revision: number;
    algorithm_version: number;
    algorithm_revision: string;
  };
}

export interface CalibrationMetricSource {
  method: string;
  target_type: string;
  /** #993 演进 v4 五态标签；历史行缺省。 */
  state?: string;
  measurement_quality: string;
  effort_support: string;
  support: string;
  range_low?: number | null;
  range_high?: number | null;
  range_meaning: string;
  evidence_date?: string;
  latest_rejected_evidence_date?: string;
  latest_stale_evidence_date?: string;
  rejected_reasons?: string[];
  independent_activities: number;
  independent_days: number;
  lab_method?: string;
  reasons: string[] | null;
  limitations: string[] | null;
  evidence_count: number;
  evidence?: Array<{
    activity_id: string;
    root_activity_id: string;
    activity_day: string;
    source_version: string;
    evidence_ref?: string;
    duration_s?: number;
    start_s?: number;
    end_s?: number;
    measurement_quality: string;
    effort_support: string;
  }>;
}

export interface CalibrationSource {
  schema_version: number;
  state: string;
  strategy?: string;
  implementation?: string;
  parameter_version?: string;
  /** #995：原地演进 v4 的算法修订标记；历史 v4 行缺省。 */
  algorithm_revision?: string;
  data_cutoff_day?: string;
  availability_semantics?: string;
  fingerprint?: string;
  speed?: CalibrationMetricSource;
  hr?: CalibrationMetricSource;
}

export interface CalibrationMetadata {
  calibration_id?: number;
  algorithm_version?: number;
  as_of_date?: string;
  computed_at?: string;
  selection: CalibrationSelection;
  source: CalibrationSource;
  fingerprint?: string;
}

export interface CalibrationPaceRange {
  fast: number | null;
  slow: number | null;
  meaning: string;
  bound_kind: "two_sided" | "speed_lower_bound" | "speed_upper_bound" | "unavailable";
}

export interface StrideThreshold {
  algorithm_version?: number;
  computed_at?: string;
  selection?: CalibrationSelection;
  source?: CalibrationSource;
  fingerprint?: string;
  speed_range_pace_per_km_sec?: CalibrationPaceRange;
  speed_mps: number | null;
  /** 阈值配速（s/km），如 300 表示 5:00/km */
  pace_per_km_sec: number | null;
  hr_bpm: number | null;
  speed_confidence: string | null;
  hr_confidence: string | null;
  as_of_date: string;
  calibration_id: number;
}

export interface StridePaceZone {
  name: string; // 'Z1' ... 'Z5'
  label: string; // '轻松' / '有氧' / ...
  /** 慢侧边界（'M:SS' /km） */
  lower_pace: string | null;
  /** 快侧边界（'M:SS' /km） */
  upper_pace: string | null;
}

export interface StrideHrZone {
  name: string;
  label: string;
  lower_bpm: number | null;
  upper_bpm: number | null;
}

export interface StrideZonesResponse {
  selection?: CalibrationSelection;
  source?: CalibrationSource;
  threshold: StrideThreshold | null;
  pace_zones: StridePaceZone[];
  hr_zones: StrideHrZone[];
  threshold_history?: StrideThresholdHistoryPoint[];
  threshold_history_prior_pace_per_km_sec?: number;
}

export interface StrideThresholdHistoryPoint {
  as_of_date: string;
  pace_per_km_sec: number | null;
  hr_bpm: number | null;
}
