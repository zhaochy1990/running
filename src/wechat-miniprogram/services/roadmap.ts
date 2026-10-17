// 产品路线服务层 —— 对接 stride-api 的产品路线投票接口。
// 后端契约：`internal/api/roadmap.go`（devops#551，契约 #515 决议）：
//
//	GET    /api/roadmap                       summary + 三区分组（一次拉全，无分页，后端已排序）
//	POST   /api/roadmap/features/:id/vote     投票（幂等；仅 Backlog 可投，否则 409 not_votable）
//	DELETE /api/roadmap/features/:id/vote     撤销（幂等）
//
// 投票/撤销后由页面本地重排，不重拉列表（devops#553）。

import { http } from './request';

/** GET /api/roadmap 的 summary 聚合块。 */
export interface RoadmapSummary {
  /** 我当前持有的票数 */
  my_votes: number;
  /** 全站实时总票数 */
  total_votes: number;
  /** 已上线想法数 */
  released_count: number;
}

/** 一个可投票的 Backlog 想法。voted 是调用者自己的投票状态。 */
export interface RoadmapBacklogItem {
  id: number;
  title: string;
  description: string;
  category: string;
  /** 创建 ≤7 天（Asia/Shanghai）派生的新想法徽章 */
  is_new: boolean;
  votes: number;
  voted: boolean;
}

/** 一个已排期（Accepted）想法；票数只读、实时。 */
export interface RoadmapAcceptedItem {
  id: number;
  title: string;
  description: string;
  category: string;
  /** 预计上线说明（如 2026.11），可能为空 */
  planned_note: string;
  votes: number;
}

/** 一个已上线（Released）想法；票数是发布时的快照，恒定。 */
export interface RoadmapReleasedItem {
  id: number;
  title: string;
  description: string;
  /** 上海时区 RFC3339 */
  released_at: string;
  votes_snapshot: number;
}

export interface RoadmapResponse {
  summary: RoadmapSummary;
  backlog: RoadmapBacklogItem[];
  accepted: RoadmapAcceptedItem[];
  released: RoadmapReleasedItem[];
}

/** POST/DELETE vote 的响应：操作后的最终状态（幂等）。 */
export interface RoadmapVoteResult {
  feature_id: number;
  voted: boolean;
}

/** 拉取产品路线全量（summary + backlog/accepted/released，后端已排序）。 */
export function getRoadmap(): Promise<RoadmapResponse> {
  return http.get<RoadmapResponse>('/api/roadmap');
}

/** 给一个想法投票（幂等；重复调用结果一致，弱网重试安全）。 */
export function voteRoadmapFeature(featureId: number): Promise<RoadmapVoteResult> {
  return http.post<RoadmapVoteResult>(`/api/roadmap/features/${featureId}/vote`);
}

/** 撤回对一个想法的投票（幂等）。 */
export function unvoteRoadmapFeature(featureId: number): Promise<RoadmapVoteResult> {
  return http.delete<RoadmapVoteResult>(`/api/roadmap/features/${featureId}/vote`);
}
