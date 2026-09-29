// 参赛计划服务层 —— 详情页「报名选择器」（#393）与「我的赛事」页（#394）
// 共用的计划 CRUD。后端契约：internal/api/race_plans.go：
//
//	GET    /api/users/me/race-plans           列表（join 赛事投影）
//	PUT    /api/users/me/race-plans/:race_id  报名选择器的创建/更新
//	DELETE /api/users/me/race-plans/:race_id  未报名 / 取消追踪
//
// 一个 (user, race) 只有一条计划，报名项目（item_type）携带在该行上。

import { http } from './request';

/** 报名状态 token（storage.RacePlanState* 词汇）。 */
export type RacePlanState = 'registered' | 'won' | 'lost' | 'confirmed';

/** 计划卡上的赛事投影（racePlanRaceDTO 镜像）。 */
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

/** 一条参赛计划（racePlanDTO 镜像）。 */
export interface RacePlan {
  race_id: number;
  item_type: string;
  state: RacePlanState;
  hotel: boolean;
  transit: boolean;
  race: RacePlanRace | null;
  /** 已下架：registered/won/confirmed 计划遇到赛事下架时的灰卡标记 */
  offboarded: boolean;
  created_at: string;
  updated_at: string;
}

/** PUT 的应答（racePlanUpsertResponse 镜像），创建与更新同构。 */
export interface RacePlanUpsertResult {
  race_id: number;
  item_type: string;
  state: RacePlanState;
  hotel: boolean;
  transit: boolean;
  created_at: string;
  updated_at: string;
}

/** 我的全部计划（按比赛日升序）。 */
export function listRacePlans(): Promise<{ plans: RacePlan[] }> {
  return http.get<{ plans: RacePlan[] }>('/api/users/me/race-plans');
}

/** 创建/更新一条计划：项目与状态必须成对提交。 */
export function upsertRacePlan(
  raceId: number,
  itemType: string,
  state: RacePlanState,
): Promise<RacePlanUpsertResult> {
  return http.put<RacePlanUpsertResult>(`/api/users/me/race-plans/${raceId}`, {
    item_type: itemType,
    state,
  });
}

/** 取消追踪（未报名）。计划不存在时后端答 404，调用方按已取消处理。 */
export function deleteRacePlan(raceId: number): Promise<void> {
  return http.delete<void>(`/api/users/me/race-plans/${raceId}`);
}
