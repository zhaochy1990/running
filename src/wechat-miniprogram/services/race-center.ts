// 赛事中心服务层 —— 对接 stride-api 用户侧赛事日历、收藏与参赛计划接口。
// 后端契约：internal/api/race_catalog.go（GET /api/race-calendar，#390）、
// internal/api/race_favorites.go（POST /api/users/me/race-favorites/:id/toggle，#391）与
// internal/api/race_plans.go（GET/PUT /api/users/me/race-plans，#391/#394）。
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

// ── 参赛计划（#394「我的赛事」页；状态机与失效分层见 race_plans.go）──

/** 计划状态四态：已报名（等抽签）/ 已中签 / 未中签 / 确认参赛。 */
export type RacePlanState = 'registered' | 'won' | 'lost' | 'confirmed';

/** 计划卡携带的赛事投影；race 行被物理删除时为 null（纯占位卡）。 */
export interface RacePlanRace {
  id: number;
  name: string;
  name_cn: string | null;
  race_date: string;
  province: string | null;
  city: string | null;
  label: string | null;
  wa_label: string | null;
}

export interface RacePlan {
  race_id: number;
  /** racetypes token（Marathon / HalfMarathon / …），即报名项目 */
  item_type: string;
  state: RacePlanState;
  hotel: boolean;
  transit: boolean;
  race: RacePlanRace | null;
  /** 赛事已下架/被删：灰卡占位、记录保留、不可交互 */
  offboarded: boolean;
  created_at: string;
  updated_at: string;
}

export interface RacePlanUpsertBody {
  /** 后端 binding:required —— 行程单独勾选时也要带上当前值 */
  item_type: string;
  state: RacePlanState;
  /** 三态：缺省=保留已存值，显式 true/false=覆盖 */
  hotel?: boolean;
  transit?: boolean;
}

/** 拉当前用户的参赛计划（含赛事投影，offboarded 分层已由后端处理）。 */
export function listRacePlans(): Promise<{ plans: RacePlan[] }> {
  return http.get<{ plans: RacePlan[] }>('/api/users/me/race-plans');
}

/** 更新一条计划（状态流转 / 行程勾选都走同一个 upsert 端点）。 */
export function updateRacePlan(
  raceId: number,
  body: RacePlanUpsertBody,
): Promise<RacePlanUpsertResponse> {
  return http.put<RacePlanUpsertResponse, RacePlanUpsertBody>(
    `/api/users/me/race-plans/${raceId}`,
    body,
  );
}

export interface RacePlanUpsertResponse {
  race_id: number;
  item_type: string;
  state: RacePlanState;
  hotel: boolean;
  transit: boolean;
  created_at: string;
  updated_at: string;
}
