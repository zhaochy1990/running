// 活动 wire 类型 —— 与后端 /api/{user}/activities 响应及 Web 端 frontend/src/api.ts
// 的 Activity 契约保持一致（字段子集，今日页/活动页用到的部分）。

/** 第二版路线形状（活动列表 `route_thumb` 的 `{"v":2,...}` 对象，devops#1037 下发）。
 * 坐标同在 [0,100]×[0,100] 视框。语义见 Go `internal/thumbnail/route_v2.go`（EncodeV2），
 * 解析与绘制见 utils/routeThumb.ts。 */
export interface RouteShapeV2 {
  v: 2;
  /** 各段折线，按时间顺序各自单独起笔；同一坐标出现在两段 = 路口共点。 */
  strokes: number[][][];
  /** 定位序列的真实起点 / 终点：是位置，不是任何一段的端点（开放端保持开放，
   * 不得按距离接到相邻段上）。 */
  start: [number, number];
  end: [number, number];
  /** 旋转包围矩形短边 / 长边（视框单位）；short = 0 表示退化直线。 */
  short: number;
  long: number;
  /** 去重前的简化轨迹总长（视框单位）。 */
  travel: number;
}

/** 活动列表行的 `route_thumb`：单通道三代并存（devops#1037）——旧版 `[[x,y],...]`
 * 单折线（未重算的存量行）/ 第二版多段对象；null（无 GPS / 未算）由字段类型表达。 */
export type RouteThumb = number[][] | RouteShapeV2;

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
  /** 手表上报的平均步幅（cm）；NULL 表示设备未上报 */
  avg_step_len_cm?: number | null;
  calories_kcal: number | null;
  /** 手表厂商上报的负荷（COROS/Garmin training_load）；仅供展示时与 STRIDE 负荷区分 */
  training_load: number | null;
  /** STRIDE 自身计算的 PMC 训练剂量（activity_training_load.training_dose），列表页展示用 */
  stride_training_dose?: number | null;
  vo2max: number | null;
  train_type: string | null;
  /** @deprecated 后端预渲染的路线缩略图 PNG 公开地址（devops#827 起客户端改画
   * route_thumb 矢量折线，本字段不再消费；P3 后端退役缩略图管线后删除）。 */
  thumb_url?: string | null;
  /** 路线形状（≤60 点，[0,100]×[0,100] 视框，三代并存见 RouteThumb），客户端 canvas
   * 矢量绘制缩略图用（devops#827；第二版多段 devops#1038）；null = 无 GPS / 未算。 */
  route_thumb?: RouteThumb | null;

  // —— 以下为详情页字段（list 端点可能不返回，故可选）——
  ascent_m?: number | null;
  aerobic_effect?: number | null;
  anaerobic_effect?: number | null;
  temperature?: number | null;
  humidity?: number | null;
  feels_like?: number | null;
  wind_speed?: number | null;
  feel_type?: number | null;
  /** 运动员经教练对话补填的体感原话（自由文本）；null = 没说过。 */
  feel_note?: string | null;
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

/** 分段行 —— 与后端 `segments` 数组同形（`type2` 手表圈/间歇组，或回落 `autoKm`）。 */
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

export interface RunningDynamicsRange {
  index: number;
  min: number;
  max: number;
}

export interface RunningDynamicsMetric {
  average: number;
  min: number;
  max: number;
  windows: RunningDynamicsRange[];
}

export type RunningDynamicsKey = 'cadence' | 'stride_length' | 'vertical_oscillation' | 'ground_contact_time';

export interface RunningDynamics {
  duration_s: number;
  window_s: number;
  metrics: Partial<Record<RunningDynamicsKey, RunningDynamicsMetric>>;
}

export interface ActivityDetailResponse {
  activity: Activity;
  stride_training_load?: ActivityStrideTrainingLoad | null;
  segments: Segment[];
  kilometer_splits?: Segment[];
  zones: Zone[];
  /** 仅在请求 include=timeseries 时返回；否则缺失/空数组。 */
  timeseries?: TimeseriesPoint[];
  running_dynamics?: RunningDynamics;
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
