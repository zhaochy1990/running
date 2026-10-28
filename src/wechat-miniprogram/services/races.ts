// 我的比赛服务层 —— 对接 stride-api 的已确认比赛经历接口。
// 后端契约：`internal/api/races.go`：
//
//	GET    /api/{user}/races                        列表（新→旧）
//	PATCH  /api/{user}/races/{labelId}              手输名（空串=清除，204）
//	DELETE /api/{user}/races/{labelId}/calendar-match 清除日历识别（204）
// 数据来自 race detection 流水线：同步后自动检测半马/全马比赛活动，
// 确认后落 races 表；明细（名称/距离/用时）以 activities 为准。

import { http } from './request';

/** 比赛距离档位，复用后端 race detection 的档位词汇。 */
export type RaceDistanceBand = 'marathon' | 'half_marathon' | 'other';

/** 一场已确认的比赛。后端已预格式化 date/duration_fmt/pace_fmt（上海时区）。 */
export interface RaceItem {
  label_id: string;
  name: string | null;
  /** 日历身份链（devops#544）：官方赛名，未关联日历时为 null */
  race_name: string | null;
  /** 手输名（运动员自己起的名字），未设置时为 null */
  display_name: string | null;
  /** 中国田协认证档位，未关联日历时为 null */
  label: string | null;
  /** 世界田联标牌档位，未关联日历时为 null */
  wa_label: string | null;
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
  /** @deprecated 路线缩略图 PNG 地址；devops#827 起小程序不再消费（P3 后端退役后删）。 */
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

/** 设置一场比赛的手输名；空串=清除（后端 trim 后落 NULL）。204 无响应体。 */
export function setRaceDisplayName(userId: string, labelId: string, name: string): Promise<void> {
  return http.patch<void, { display_name: string }>(
    `/api/${encodeURIComponent(userId)}/races/${encodeURIComponent(labelId)}`,
    { display_name: name },
  );
}

/** 清除一场比赛的日历识别（「这不是这场比赛」）：断开关联并记 user_cleared，204。 */
export function clearRaceCalendarMatch(userId: string, labelId: string): Promise<void> {
  return http.delete<void>(
    `/api/${encodeURIComponent(userId)}/races/${encodeURIComponent(labelId)}/calendar-match`,
  );
}
