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
