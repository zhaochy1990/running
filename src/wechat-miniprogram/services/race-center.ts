// 赛事中心服务层 —— 对接 stride-api 用户侧赛事日历与收藏接口。
// 后端契约：internal/api/race_catalog.go（GET /api/race-calendar，#390；GET
// /api/race-calendar/:race_id 详情，#393）与 internal/api/race_favorites.go
// （POST /api/users/me/race-favorites/:id/toggle，#391）。
// 列表行自带 favorited 星标态；收藏视图由客户端按该标记过滤，无需单独拉收藏 id 集。

import { http } from './request';

/** 赛事日历一行（后端 userRaceSummaryDTO）：密表行所需字段的只读投影。 */
export interface RaceCalendarRace {
  id: number;
  /** 英文名（源数据 canonical 名） */
  name: string;
  /** 中文名，null 时页面回落到 name */
  name_cn: string | null;
  /** 比赛日 YYYY-MM-DD（上海时区口径） */
  race_date: string;
  province: string | null;
  /** 城市（race_calendar.city 拼写，如 厦门市），null=未录入 */
  city: string | null;
  /** 中国田协认证：A / B / C / C（属地办赛） / 系列赛，null=无 */
  label: string | null;
  /** 世界田联标牌：Gold / Platinum / Label / Elite，null=无 */
  wa_label: string | null;
  /** racetypes 词汇 token：Marathon / HalfMarathon / {n}Km / Other / Unknown */
  race_types: string[];
  /** 请求用户是否已收藏该赛事 */
  favorited: boolean;
}

export interface RaceCalendarResponse {
  races: RaceCalendarRace[];
  total: number;
  page: number;
  per_page: number;
}

export interface RaceCalendarParams {
  year?: string;
  /** upcoming（默认，仅 race_date >= 今天）/ all（整年，含已结束） */
  scope?: 'upcoming' | 'all';
  /** 省份原文（race_calendar.province 拼写，如 浙江省）；服务端精确匹配 */
  province?: string;
  page?: number;
  perPage?: number;
}

export interface RaceFavoriteToggleResponse {
  race_id: number;
  favorited: boolean;
}

/** 拉一页已发布赛事（按 race_date 升序）。 */
export function getRaceCalendar(params: RaceCalendarParams): Promise<RaceCalendarResponse> {
  const q: string[] = [];
  if (params.year) q.push(`year=${encodeURIComponent(params.year)}`);
  if (params.scope) q.push(`scope=${params.scope}`);
  if (params.province) q.push(`province=${encodeURIComponent(params.province)}`);
  q.push(`page=${params.page ?? 1}`);
  q.push(`per_page=${params.perPage ?? 100}`);
  return http.get<RaceCalendarResponse>(`/api/race-calendar?${q.join('&')}`);
}

/** 收藏星标切换，返回服务端的最终状态（并发点击时以此为准）。 */
export function toggleRaceFavorite(raceId: number): Promise<RaceFavoriteToggleResponse> {
  return http.post<RaceFavoriteToggleResponse>(
    `/api/users/me/race-favorites/${raceId}/toggle`,
  );
}

/* ──────────────────────────────────────────────────────────────────────────
   详情（#393）：GET /api/race-calendar/:race_id 的 userRaceDetailDTO 镜像。
   项目十二列内容里 v1 详情页只渲染 距离/起终点/赛道文字/关门，其余列
   （爬升/海拔点/难点/补给/奖金/口碑/照片）留给后续版本，接口一到位即可补。
   ────────────────────────────────────────────────────────────────────────── */

/** 报名时间轴（storage.RaceSignupTimeline 镜像）。日期均为 YYYY-MM-DD。 */
export interface RaceSignupTimeline {
  start_at: string;
  deadline: string;
  lottery: boolean;
  lottery_result_at: string | null;
  payment_deadline: string | null;
}

/**
 * 报名渠道（storage.RaceSignupChannel 镜像）。type 描述渠道形态（官网 /
 * 公众号 / 合作App），url_type 区分唯一链接是可打开的页面（web）还是二维码
 * 图片（qrcode）——前者给「复制链接」，后者只标注形态；url 为 null 的渠道
 * 连链接都没有（如“关注公众号报名”），照常展示。
 */
export interface RaceSignupChannel {
  name: string;
  type: string;
  url: string | null;
  url_type: string;
}

/** 领物窗口（storage.RacePacketPickup 镜像）。 */
export interface RacePacketPickup {
  time: string;
  location: string;
}

/** 起终点（storage.RacePoint 的 v1 投影）：详情页只渲染名称，坐标不镜像。 */
export interface RacePoint {
  name: string;
}

/** 关门点（storage.RaceCutoff 的 v1 投影）：位置名 + 当日墙钟 HH:MM。 */
export interface RaceCutoff {
  point: string;
  cutoff_at: string;
}

/** 详情页一个项目（userRaceItemDTO 的 v1 投影）。entry_fee 单位是分。
 * 内容列遵循后端「absent-when-empty as null」契约：仅基础字段的赛事
 * cutoffs 为 null（e2e #395 曾因按非空数组 .map 白屏）。 */
export interface RaceItem {
  id: number;
  name: string;
  type: string;
  start_time: string | null;
  entry_fee: number | null;
  quota: number | null;
  distance_km: number | null;
  start_point: RacePoint | null;
  finish_point: RacePoint | null;
  route_description: string | null;
  cutoffs: RaceCutoff[] | null;
}

/** 城市介绍（userCityContentDTO 的 v1 投影：图片/省份列不镜像）。 */
export interface RaceCityContent {
  city: string;
  intro: { overview: string; culture: string; food: string; history: string } | null;
  attractions: Array<{ name: string; description: string }> | null;
}

/** 赛事详情（userRaceDetailDTO 镜像）：列表行字段 + 三段内容区。
 * 内容区遵循后端「absent-when-empty as null」契约：未维护内容的赛事
 * signup_channels / packet_pickup 为 null（items 恒为数组，Go 侧 make 保证）。 */
export interface RaceDetail extends RaceCalendarRace {
  signup_timeline: RaceSignupTimeline | null;
  signup_channels: RaceSignupChannel[] | null;
  packet_pickup: RacePacketPickup[] | null;
  items: RaceItem[];
  city_content: RaceCityContent | null;
  /** 内容是否经过调研（事件级 content_source 有值的派生布尔）：v2 比赛策略入口门槛。 */
  strategy_available: boolean;
}

/** 拉一场已发布赛事的详情；未发布/不存在均 404。 */
export function getRaceDetail(raceId: number): Promise<RaceDetail> {
  return http.get<RaceDetail>(`/api/race-calendar/${raceId}`);
}
