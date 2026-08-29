// 活动 wire 类型 —— 与后端 /api/{user}/activities 响应及 Web 端 frontend/src/api.ts
// 的 Activity 契约保持一致（字段子集，今日页/活动页用到的部分）。

export interface Activity {
  label_id: string;
  name: string | null;
  sport_type: number;
  /** 可为 null：后端（Go/Python）对个别活动（如未标注运动类型的历史数据）返回 null */
  sport_name: string | null;
  /** 上海本地 YYYY-MM-DD（后端在序列化前已转上海时区） */
  date: string;
  distance_m: number;
  distance_km: number;
  duration_s: number;
  duration_fmt: string;
  avg_pace_s_km: number | null;
  pace_fmt: string;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  calories_kcal: number | null;
  training_load: number | null;
  vo2max: number | null;
  train_type: string | null;

  // —— 以下为详情页字段（list 端点可能不返回，故可选）——
  ascent_m?: number | null;
  aerobic_effect?: number | null;
  anaerobic_effect?: number | null;
  temperature?: number | null;
  humidity?: number | null;
  feels_like?: number | null;
  wind_speed?: number | null;
  feel_type?: number | null;
  sport_note?: string | null;
  pauses?: Pause[];
  commentary?: string | null;
  commentary_generated_by?: string | null;
  commentary_generated_at?: string | null;
}

/** 手表暂停区间。timestamp 为原始 COROS 厘秒；换算方式与 timeseries 一致。 */
export interface Pause {
  start_ts: number | null;
  end_ts: number | null;
  type: number | null;
}

/** 自动公里分段（lap_type 'autoKm'）或力量段（'type2'）。 */
export interface Lap {
  lap_index: number;
  lap_type: string;
  distance_m: number | null;
  distance_km: number | null;
  duration_s: number | null;
  duration_fmt: string;
  avg_pace: number | null;
  pace_fmt: string;
  adjusted_pace: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  avg_power: number | null;
  ascent_m: number | null;
  descent_m: number | null;
}

export interface Segment extends Lap {
  seg_name: string;
  mode: number | null;
}

/** 手表上报区间（Go）或校准区间（Python），percent 为该区间时长占比。 */
export interface Zone {
  zone_type: string;
  zone_index: number;
  range_min: number | null;
  range_max: number | null;
  range_unit: string | null;
  duration_s: number | null;
  percent: number | null;
}

export interface TimeseriesPoint {
  timestamp: number | null;
  distance: number | null;
  heart_rate: number | null;
  speed: number | null;
  adjusted_pace: number | null;
  cadence: number | null;
  altitude: number | null;
  power: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
}

export interface LinkedScheduledWorkout {
  id: number;
  abandoned_by_promote_at: string | null;
}

export interface ActivityStrideTrainingLoad {
  label_id: string;
  activity_date: string;
  sport: string | null;
  session_class: string | null;
  algorithm_version: number;
  calibration_id: number | null;
  cardio_load_raw: number | null;
  cardio_tss: number | null;
  external_tss: number | null;
  high_intensity_tss: number | null;
  mechanical_load: number | null;
  subjective_internal_load: number | null;
  training_dose: number | null;
  training_dose_source: string | null;
  cardio_coverage: number;
  external_coverage: number;
  high_intensity_coverage: number;
  coverage_status: string;
  load_confidence: string | null;
  excluded_from_pmc: boolean;
  reasons: string[];
}

export interface ActivityDetailResponse {
  activity: Activity;
  stride_training_load?: ActivityStrideTrainingLoad | null;
  laps: Lap[];
  segments: Segment[];
  zones: Zone[];
  /** 仅在请求 include=timeseries 时返回；否则缺失/空数组。 */
  timeseries?: TimeseriesPoint[];
  linked_scheduled_workout?: LinkedScheduledWorkout | null;
}

export interface ActivityMonthlySummary {
  activity_count: number;
  total_run_km: number;
  run_duration_s: number;
  duration_s: number;
}

export interface ActivitiesListResponse {
  total: number;
  offset: number;
  limit: number;
  activities: Activity[];
  /** 本页可见各上海月份的聚合（键为 YYYY-MM），可选——旧后端可能不返回 */
  monthly_summaries?: Record<string, ActivityMonthlySummary>;
}
