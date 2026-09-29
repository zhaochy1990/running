// 我的比赛服务层 —— 对接 stride-api 的已确认比赛经历接口。
// 后端契约：`internal/api/races.go`（GET /api/{user}/races）。
// 数据来自 race detection 流水线：同步后自动检测半马/全马比赛活动，
// 确认后落 races 表；明细（名称/距离/用时）以 activities 为准。

import { http } from './request';

/** 比赛距离档位，复用后端 race detection 的档位词汇。 */
export type RaceDistanceBand = 'marathon' | 'half_marathon' | 'other';

/** 一场已确认的比赛。后端已预格式化 date/duration_fmt/pace_fmt（上海时区）。 */
export interface RaceItem {
  label_id: string;
  name: string | null;
  sport_name: string | null;
  /** 上海时区 ISO 8601（带 +08:00 偏移） */
  date: string;
  distance_band: RaceDistanceBand;
  distance_m: number | null;
  distance_km: number;
  duration_s: number | null;
  duration_fmt: string;
  avg_pace_s_km: number | null;
  pace_fmt: string;
  avg_hr: number | null;
  max_hr: number | null;
  ascent_m: number | null;
  thumb_url: string | null;
}

export interface RacesResponse {
  user_id: string;
  races: RaceItem[];
}

/** 拉取用户已确认的比赛列表（新→旧）。 */
export function getMyRaces(userId: string): Promise<RacesResponse> {
  return http.get<RacesResponse>(`/api/${encodeURIComponent(userId)}/races`);
}
