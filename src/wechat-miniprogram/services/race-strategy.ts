// 比赛策略服务层 —— #396。对接 Go 侧 race_strategy 端点：
//   GET /api/users/me/race-strategies/:race_id   （详情卡摘要态 / 报告页）
//   PUT /api/users/me/race-strategies/:race_id   （报告页手动编辑保存）
// 内容结构是 coach_contract RaceStrategySchema 的镜像（教练生成初稿，TS 侧
// 落库；分段配速与补给可手动编辑，再聊一轮=教练更新版本——服务端只留最新版）。

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

/** GET /api/users/me/race-strategies/:race_id 的响应（raceStrategyDTO 镜像）。 */
export interface RaceStrategyResponse {
  race_id: number;
  item_type: string;
  content: RaceStrategy;
  created_at: string;
  updated_at: string;
}

/** 拉当前用户一场赛事的最新策略；未生成抛 404（调用方按未生成渲染 CTA）。 */
export function getRaceStrategy(raceId: number): Promise<RaceStrategyResponse> {
  return http.get<RaceStrategyResponse>(`/api/users/me/race-strategies/${raceId}`);
}

/** 保存报告页手动编辑（覆盖最新版）。 */
export function saveRaceStrategy(raceId: number, body: { item_type: string; content: RaceStrategy }): Promise<{ race_id: number; updated_at: string }> {
  return http.put<{ race_id: number; updated_at: string }, { item_type: string; content: RaceStrategy }>(
    `/api/users/me/race-strategies/${raceId}`,
    body,
  );
}

/** 「设为目标」预填体（POST /api/users/me/training-goal；后端 goals.go goalInput）。 */
export interface TrainingGoalInput {
  race_date: string;
  race_distance: string;
  race_name: string;
  target_finish_time: string;
  race_location: string | null;
  /** 3–6，必填：目标确认弹层里由用户选择。 */
  weekly_training_days: number;
}

/** 把这场比赛设为目标赛事（新目标会归档既有活跃目标——服务端语义）。 */
export function postTrainingGoal(goal: TrainingGoalInput): Promise<unknown> {
  return http.post<unknown, TrainingGoalInput>('/api/users/me/training-goal', goal);
}
