// 赛季训练计划服务层 —— #428 起卡片契约的客户端镜像。承载两块：
// 1. 教练会话里 `master-plan` 卡片信封的数据形状（coach_contract
//    MasterPlanCardSchema 镜像，数值口径由后端 zod 把关）；卡片 data 只带
//    渲染/定位需要的标量摘要，阶段时间轴与负荷投影走 markdown 正文。
// 2. #436 起展示页用的 `GET /master-plan/current` 信封与 v2 plan 类型镜像
//    （frontend/src/api.ts 的 CurrentSeasonPlan 同构）；v1 计划是 markdown
//    字符串，小程序端不渲染，只提示去网页看。#429 的 draft 落库/启用流程
//    在此扩展端点与 plan_id。

import { http, ApiError } from './request';

/** 赛季目标（卡片的 goal 摘要）。 */
export interface MasterPlanCardGoal {
  race_name: string;
  distance: 'FM' | 'HM';
  race_date: string;
  /** h:mm:ss 目标成绩；完赛为目标时空串。 */
  target_time: string;
}

/** `master-plan` 卡片信封的 data（MasterPlanCardSchema 镜像）。 */
export interface MasterPlanCard {
  goal: MasterPlanCardGoal;
  start_date: string;
  end_date: string;
  total_weeks: number;
  /** #429：draft 落库后的 plan_id，卡片「启用/放弃」CTA 的定位；缺省 = 旧
   * 卡片或落库失败降级，前端不渲染 CTA。 */
  plan_id?: string;
}

// ---------------------------------------------------------------------------
// current 信封与 v2 plan（frontend/src/api.ts 的镜像，字段口径以 Go 端
// currentSeasonPlanEnvelope / SeasonPlanContent 为准）
// ---------------------------------------------------------------------------

/** v2 plan 的 goal（SeasonPlanGoal 镜像）。 */
export interface MasterPlanGoal {
  goal_id: string;
  race_name?: string;
  distance?: string;
  race_date?: string;
  target_time?: string;
  timezone?: string;
  location?: string | null;
}

/** 已完成阶段的心率区间占比（HrZoneShare 镜像）。 */
export interface HrZoneShare {
  zone_index: number;
  minutes: number;
  percent: number;
}

/** 已完成阶段的实际结果汇总（CompletedPhaseSummary 镜像）。 */
export interface CompletedPhaseSummary {
  total_distance_km: number;
  run_count: number;
  weekly_avg_km: number;
  avg_pace_s_km: number | null;
  avg_pace_fmt: string;
  avg_hr: number | null;
  hr_zone_distribution: HrZoneShare[];
}

/** v2 plan 的阶段（MasterPlanPhase 镜像）。 */
export interface MasterPlanPhase {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  focus: string;
  weekly_distance_km_low: number;
  weekly_distance_km_high: number;
  key_session_types: string[];
  milestone_ids: string[];
  phase_type?: string;
  rhythm?: string;
  key_workouts?: string;
  monitoring_triggers?: string[];
  coach_note?: string;
  is_completed?: boolean;
  summary?: CompletedPhaseSummary | null;
}

/** 周关键课（KeySessionSchema 镜像；type 为 11 值枚举，宽松收 string）。 */
export interface MasterPlanKeySession {
  type: string;
  distance_km: number | null;
  duration_min: number | null;
  intensity?: string | null;
  purpose?: string | null;
}

/** v2 plan 的周行 + 实际值 overlay（MasterPlanWeek 镜像）。 */
export interface MasterPlanWeek {
  week_index: number;
  week_start: string;
  week_end?: string | null;
  phase_id: string;
  target_weekly_km_low: number | null;
  target_weekly_km_high: number | null;
  target_training_dose_low?: number | null;
  target_training_dose_high?: number | null;
  key_sessions: MasterPlanKeySession[];
  is_recovery_week?: boolean;
  is_taper_week?: boolean;
  planned_distance_km?: number | null;
  is_completed?: boolean;
  actual_distance_km?: number | null;
  actual_avg_pace_s_km?: number | null;
  actual_avg_pace_fmt?: string;
  actual_avg_hr?: number | null;
  actual_run_count?: number;
  actual_duration_s?: number;
  actual_training_dose?: number | null;
  actual_training_dose_coverage?: number | null;
  actual_training_dose_status?: 'complete' | 'partial' | 'unknown' | null;
}

/** 负荷投影可用性（MasterPlanTrainingLoadProjection 镜像）。 */
export interface MasterPlanTrainingLoadProjection {
  status: 'available' | 'unavailable';
  unavailable_reason:
    | 'weekly_skeleton_unavailable'
    | 'personal_threshold_unavailable'
    | 'planned_session_uncomputable'
    | null;
  calculated_at: string;
}

/** 里程碑（MasterPlanMilestone 镜像）。 */
export interface MasterPlanMilestone {
  id: string;
  type: string;
  date: string;
  phase_id: string;
  target: string;
  completed_actual: string | null;
}

/** 后端派生的下一个里程碑（MasterPlanNextMilestone 镜像）。 */
export interface MasterPlanNextMilestone {
  id: string;
  date: string;
  target: string;
  days_until: number;
}

/** v2 plan 正文（SeasonPlanContent 镜像）。 */
export interface SeasonPlanContent {
  goal: MasterPlanGoal;
  start_date: string;
  end_date: string;
  total_weeks: number;
  phases: MasterPlanPhase[];
  milestones: MasterPlanMilestone[];
  weeks: MasterPlanWeek[];
  training_load_projection?: MasterPlanTrainingLoadProjection | null;
  training_principles: string[];
  generated_by: string;
  current_phase_id: string | null;
  current_week_number: number | null;
  next_milestone: MasterPlanNextMilestone | null;
}

interface CurrentSeasonPlanBase {
  status: 'active';
  plan_id: string;
  goal_id: string;
  created_at: string;
  updated_at: string;
}

/** GET /master-plan/current 的信封：v1 正文是 markdown 字符串，v2 是结构化 plan。 */
export type CurrentSeasonPlan =
  | (CurrentSeasonPlanBase & {
      content_version: 1;
      revision: null;
      plan: string;
    })
  | (CurrentSeasonPlanBase & {
      content_version: 2;
      revision: number;
      plan: SeasonPlanContent;
    });

/**
 * 拉当前用户启用中的赛季训练计划；没有（后端 404）返回 null，
 * 其余错误原样抛出由页面区分 loading/error。
 */
export async function getCurrentMasterPlan(userId: string): Promise<CurrentSeasonPlan | null> {
  try {
    return await http.get<CurrentSeasonPlan>(
      `/api/users/${encodeURIComponent(userId)}/master-plan/current`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      return null;
    }
    throw err;
  }
}

/** POST .../drafts/:plan_id/activate 的响应（Go activateMasterPlanDraftResponse）。 */
export interface ActivateDraftResponse {
  success: boolean;
  plan: CurrentSeasonPlan;
  /** 被替换归档的旧 active 计划 id；首次启用为 null。 */
  replaced_plan_id: string | null;
}

/**
 * 启用一版训练计划草稿（#429 卡片 CTA）：服务端事务内归档旧 active、把该
 * draft 升为 active（单人单 active 由底座保证）。409 = 该 plan 已不是草稿
 * （可能已在别处启用），404 = 草稿不存在。
 */
export function activateMasterPlanDraft(userId: string, planId: string): Promise<ActivateDraftResponse> {
  return http.post<ActivateDraftResponse>(
    `/api/users/${encodeURIComponent(userId)}/master-plan/drafts/${encodeURIComponent(planId)}/activate`,
  );
}

/** 放弃一版草稿（归档，不可再启用）；404 = 草稿不存在或已非草稿。 */
export function abandonMasterPlanDraft(
  userId: string,
  planId: string,
): Promise<{ success: boolean; plan_id: string; status: string }> {
  return http.post<{ success: boolean; plan_id: string; status: string }>(
    `/api/users/${encodeURIComponent(userId)}/master-plan/drafts/${encodeURIComponent(planId)}/abandon`,
  );
}
