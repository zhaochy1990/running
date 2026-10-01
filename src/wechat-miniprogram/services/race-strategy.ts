// 比赛策略服务层 —— #396。对接 Go 侧 race_strategy 端点：
//   GET    /api/users/me/race-strategies/:race_id（详情卡摘要态 / 报告页，全量版本）
//   PUT    /api/users/me/race-strategies/:race_id（报告页手动编辑保存）
//   DELETE /api/users/me/race-strategies/:race_id?target=（删除某个目标的版本）
// 内容结构是 coach_contract RaceStrategySchema 的镜像。同一场比赛按目标成绩
// 多版本共存（如 2:55 一版、2:50 一版）：content.target_finish_time 是版本键，
// 同目标再生成/编辑=覆盖该版，其它目标不受影响——目标选哪个是用户自己的决策。

import { http } from './request';

/** 分段配速表一行（五列：分段/本段配速/本段用时/累计用时/说明）。 */
export interface RacePaceSegment {
  segment: string;
  /** 本段距离 km；null=未知（用时无法自动换算）。 */
  distance_km: number | null;
  pace: string;
  segment_time: string;
  cumulative_time: string;
  note: string;
}

/** 补给计划一行：时间点｜内容。 */
export interface RaceFuelingItem {
  time_point: string;
  content: string;
}

/** 教练生成的比赛策略内容（RaceStrategySchema 镜像）。 */
export interface RaceStrategy {
  race_name: string;
  item_type: string;
  target_finish_time: string;
  summary: string;
  pace_segments: RacePaceSegment[];
  fueling_plan: RaceFuelingItem[];
  course_tips: string[];
  weather_tips: string[];
  basis_note: string;
}

/** 一个目标版本的落库视图（raceStrategyVersionDTO 镜像）。 */
export interface RaceStrategyVersion {
  target_finish_time: string;
  item_type: string;
  content: RaceStrategy;
  updated_at: string;
}

/** GET /api/users/me/race-strategies/:race_id 的响应：全部版本，目标最快在前。 */
export interface RaceStrategyListResponse {
  race_id: number;
  strategies: RaceStrategyVersion[];
}

/** 拉当前用户一场赛事的全部策略版本；未生成时 strategies 为空数组（200）。 */
export function getRaceStrategies(raceId: number): Promise<RaceStrategyListResponse> {
  return http.get<RaceStrategyListResponse>(`/api/users/me/race-strategies/${raceId}`);
}

/** 最近更新的版本（详情卡摘要与报告页的默认选中；空列表返回 null）。 */
export function latestStrategyVersion(versions: RaceStrategyVersion[]): RaceStrategyVersion | null {
  let latest: RaceStrategyVersion | null = null;
  for (const v of versions) {
    if (latest === null || v.updated_at > latest.updated_at) latest = v;
  }
  return latest;
}

// ── 教练会话 → 报告页的草稿交接 ─────────────────────────────────────────────
// 教练生成的策略初稿不再自动落库（由用户在报告页「应用」触发保存）；聊天卡片
// tap 时把草稿暂存本地，报告页 onLoad 取走后进草稿模式（本地渲染 + 应用保存）。
// navigateTo 的 query 带不动大 JSON，沿用 setPendingCoachContext 的 storage 交接模式。
const PENDING_DRAFT_KEY = 'raceStrategy.pendingDraft';

/** 聊天卡片 tap 时交接给报告页的策略草稿。 */
export interface PendingStrategyDraft {
  raceId: number;
  strategy: RaceStrategy;
}

export function setPendingStrategyDraft(draft: PendingStrategyDraft): void {
  try {
    wx.setStorageSync(PENDING_DRAFT_KEY, draft);
  } catch {
    /* ignore */
  }
}

/**
 * 取走草稿（仅一次）：raceId 匹配才消费；不匹配（残留的过期草稿）直接丢弃。
 * 返回 null 时报告页走服务端已保存版本。
 */
export function takePendingStrategyDraft(raceId: number): PendingStrategyDraft | null {
  try {
    const v = wx.getStorageSync(PENDING_DRAFT_KEY);
    wx.removeStorageSync(PENDING_DRAFT_KEY);
    if (v && typeof v === 'object' && v.raceId === raceId && v.strategy && Array.isArray(v.strategy.pace_segments)) {
      return v as PendingStrategyDraft;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 保存报告页手动编辑：content.target_finish_time 是版本键——同目标覆盖该版，
 * 不同目标落成新版本。响应带 target_finish_time 供调用方定位版本。
 */
export function saveRaceStrategy(
  raceId: number,
  body: { item_type: string; content: RaceStrategy },
): Promise<{ race_id: number; target_finish_time: string; updated_at: string }> {
  return http.put<{ race_id: number; target_finish_time: string; updated_at: string }, { item_type: string; content: RaceStrategy }>(
    `/api/users/me/race-strategies/${raceId}`,
    body,
  );
}

/** 删除某个目标的版本（其它版本不动）。 */
export function deleteRaceStrategy(raceId: number, targetFinishTime: string): Promise<void> {
  return http.delete<void>(`/api/users/me/race-strategies/${raceId}?target=${encodeURIComponent(targetFinishTime)}`);
}
