// 自定义比赛服务层 ——「我的比赛」手动添加的赛历外赛事（#474 后端 / #475 小程序）。
// 后端契约：internal/api/custom_races.go：
//
//	POST   /api/users/me/custom-races     创建（201 返回存储行）
//	PUT    /api/users/me/custom-races/:id 全量更新（缺省的可选字段会被清空）
//	DELETE /api/users/me/custom-races/:id 物理删除（204）
//	GET    /api/users/me/my-races         聚合：官方计划卡 + 自定义卡混排
//
// hotel/transit 在 v1 契约只有读没有写路径（列按 #457 DDL 保留），请求体不带。

import { http } from './request';
import type { RacePlan } from './race-plans';

/** 参赛状态 token（storage.CustomRaceState* 词汇；「已结束」读时按日期派生，不落库）。 */
export type CustomRaceState = 'want' | 'registered';

/** 一条自定义比赛（customRaceDTO 镜像）；done = 比赛日已过（上海时区）派生标志。 */
export interface CustomRace {
  id: number;
  name: string;
  race_date: string;
  item_type: string;
  distance_km: number | null;
  ascent_m: number | null;
  city: string;
  website: string;
  note: string;
  state: CustomRaceState;
  hotel: boolean;
  transit: boolean;
  done: boolean;
  created_at: string;
  updated_at: string;
}

/** 创建/全量更新请求体（customRaceRequest 镜像）：必填 name / race_date / item_type；
 *  日期无上下界（过去 = 补录，远未来允许，#457 修正决议）。 */
export interface CustomRaceBody {
  name: string;
  race_date: string;
  item_type: string;
  distance_km?: number | null;
  ascent_m?: number | null;
  city?: string;
  website?: string;
  note?: string;
  state?: CustomRaceState;
}

/** 聚合端点的一张卡（myRaceItem 镜像）：official 的 plan 即 race-plans DTO 原样。 */
export interface MyRaceItem {
  source: 'official' | 'custom';
  plan?: RacePlan;
  race?: CustomRace;
}

/** 我的比赛聚合列表：未结束按比赛日升序，已结束沉底（组内升序），无分页。 */
export function fetchMyRaces(): Promise<{ items: MyRaceItem[] }> {
  return http.get<{ items: MyRaceItem[] }>('/api/users/me/my-races');
}

export function createCustomRace(body: CustomRaceBody): Promise<CustomRace> {
  return http.post<CustomRace, CustomRaceBody>('/api/users/me/custom-races', body);
}

export function updateCustomRace(id: number, body: CustomRaceBody): Promise<CustomRace> {
  return http.put<CustomRace, CustomRaceBody>(`/api/users/me/custom-races/${id}`, body);
}

/** 物理删除。id 非本人或不存在时后端答 404，调用方按已删除处理。 */
export function deleteCustomRace(id: number): Promise<void> {
  return http.delete<void>(`/api/users/me/custom-races/${id}`);
}
