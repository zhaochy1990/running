// 赛季训练计划服务层 —— #428 起卡片契约的客户端镜像。承载两块：
// 1. 教练会话里 `master-plan` 卡片信封的数据形状（coach_contract
//    MasterPlanCardSchema 镜像，数值口径由后端 zod 把关）；卡片 data 只带
//    渲染/定位需要的标量摘要，阶段时间轴与负荷投影走 markdown 正文。
// 2. #436 起展示页用的 `GET /master-plan/current` 信封与 v2 plan 类型镜像
//    （frontend/src/api.ts 的 CurrentSeasonPlan 同构）；v1 计划是 markdown
//    字符串，小程序端不渲染，只提示去网页看。#585 起 apply-from-content
//    （POST /master-plan/apply）在此扩展端点；draft 端点已下线。

import { http, ApiError } from './request';
import type { Weekday } from '../utils/weekday';

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
  /** #585 apply-from-content：完整 v2 计划 doc + 一次性 apply_token（幂等
   * 键），成对出现；缺省 = 降级卡片（无 race goal）或旧卡片（#429 只带
   * plan_id），无「应用」CTA。 */
  apply_token?: string;
  content?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 训练计划创建表单卡（#1024 R2）
// ---------------------------------------------------------------------------

/** 星期枚举类型（coach_contract WEEKDAY_VALUES 镜像；纯模块在 utils/weekday）。 */
export type { Weekday } from '../utils/weekday';

/** `master-plan-form` 卡片信封的 data（MasterPlanFormCardSchema 镜像）。
 * 字段允许空串 = 待用户填写；完整性校验在生成前（提交时）做。 */
export interface MasterPlanFormCard {
  goal: {
    race_name: string;
    distance: 'FM' | 'HM';
    /** 空串 = 待用户填写；否则 YYYY-MM-DD。 */
    race_date: string;
    /** h:mm:ss 目标成绩；空串 = 顺利完赛。 */
    target_time: string;
  };
  availability: {
    weekly_days: Weekday[];
    preferred_long_run_day: Weekday | null;
  };
  /** 近期训练基础（自由文本，可空）。 */
  base: string;
  /** 伤病或其他限制（自由文本，可空）。 */
  restriction: string;
}

/** 预览交接载荷：apply-from-content 的 apply_token + 完整候选 content。 */
export interface PendingPlanPreview {
  apply_token: string;
  content: Record<string, unknown>;
}

const PENDING_PREVIEW_KEY = 'master-plan.pendingPreview';
const APPLIED_KEY_PREFIX = 'master-plan.applied.';

/**
 * 交接候选计划给训练计划页预览（聊天结果卡「查看完整计划」）。content 是
 * 完整 v2 候选（含首批 weekly_docs，约 100KB），超过 navigateTo URL 的
 * 现实上限，沿用 setPendingStrategyDraft / setPendingCoachContext 的
 * storage 交接模式。
 */
export function setPendingPlanPreview(payload: PendingPlanPreview): void {
  try {
    wx.setStorageSync(PENDING_PREVIEW_KEY, payload);
  } catch {
    /* ignore：交接失败由预览页走正常加载兜底 */
  }
}

/** 取走预览交接载荷（仅一次）。 */
export function takePendingPlanPreview(): PendingPlanPreview | null {
  try {
    const v = wx.getStorageSync(PENDING_PREVIEW_KEY);
    if (v && typeof v === 'object') {
      wx.removeStorageSync(PENDING_PREVIEW_KEY);
      const payload = v as Partial<PendingPlanPreview>;
      if (typeof payload.apply_token === 'string' && payload.apply_token && payload.content && typeof payload.content === 'object') {
        return { apply_token: payload.apply_token, content: payload.content };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 预览页启用成功后打标（apply_token = 生成该候选的 plan job id）：聊天
 *  结果卡 onShow 据此把角标回写为「已启用」。 */
export function markMasterPlanApplied(applyToken: string): void {
  try {
    wx.setStorageSync(APPLIED_KEY_PREFIX + applyToken, true);
  } catch {
    /* ignore */
  }
}

export function isMasterPlanApplied(applyToken: string): boolean {
  try {
    return wx.getStorageSync(APPLIED_KEY_PREFIX + applyToken) === true;
  } catch {
    return false;
  }
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
  /** v3 快照阶段附带的力量/恢复安排（kernel 产物；旧计划没有）。 */
  strength?: { sessions_per_week?: number; focus?: string; timing?: string } | null;
  recovery?: { focus?: string; sleep_target_hours?: string; adjustment_trigger?: string } | null;
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
  /** 旧 v2 快照用 phase_id；v3 快照（#859 起）用 canonical phase_name，二选一。 */
  phase_id?: string;
  phase_name?: string;
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
  // —— v3 富字段（#859 kernel 全量落库，current 读原样透传；旧 v2 计划没有，
  // 全部可选，UI 逐项判空降级） ——
  /** L2 阶段划分意图（策略层阶段/里程碑 gate/量带）。 */
  policy?: MasterPlanPolicy | null;
  /** L3 周骨架（周角色/长距离/质量课配额/门检查）。 */
  skeleton?: MasterPlanSkeleton | null;
  /** VDOT 锚（新鲜度融合结果）。 */
  anchor?: MasterPlanAnchor | null;
  /** 丹系审计（items + pass/warn/fail 汇总）。 */
  audit?: MasterPlanAudit | null;
}

/** —— v3 富字段类型（wuxi-2027-plan.json artifact 镜像，宽松收口） —— */

/** 策略层阶段（PhaseDivisionIntent 的 phases 投影）。 */
export interface MasterPlanPolicyPhase {
  name: string;
  canonical?: string;
  start_week: number;
  end_week: number;
  [key: string]: unknown;
}

/** 策略层里程碑 gate（signal + 可观察 criterion）。 */
export interface MasterPlanPolicyMilestone {
  phase: string;
  signal: string;
  criterion: string;
  [key: string]: unknown;
}

/** L2 政策包（milestones.phase 以「第N阶段·XXX」前缀对应 policy.phases[].name）。 */
export interface MasterPlanPolicy {
  phases: MasterPlanPolicyPhase[];
  taper_weeks?: number;
  milestones: MasterPlanPolicyMilestone[];
  gates?: Array<Record<string, unknown>>;
  volume_bands?: Array<Record<string, unknown>>;
}

/** L3 周骨架行（role: progress/absorb/taper/race）。 */
export interface MasterPlanSkeletonWeek {
  week: number;
  canonical: string;
  block: number;
  role: string;
  km: number;
  lr: number | null;
  q: number;
}

export interface MasterPlanSkeleton {
  weeks: MasterPlanSkeletonWeek[];
  blocks?: Array<Record<string, unknown>>;
  recovery_policy?: Array<Record<string, unknown>>;
  strength_policy?: Array<Record<string, unknown>>;
  checks?: Array<Record<string, unknown>>;
  milestones?: Array<Record<string, unknown>>;
}

/** VDOT 锚。 */
export interface MasterPlanAnchor {
  as_of?: string;
  vdot?: number;
  vdot_source?: string;
  [key: string]: unknown;
}

/** 丹系审计。 */
export interface MasterPlanAudit {
  items: Array<{ verdict: 'pass' | 'warn' | 'fail'; item: string; actual?: string }>;
  summary: { pass: number; warn: number; fail: number };
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

/** 首批候选周课实际启用结果；重放只返回已应用的赛季。 */
export interface InitialWeeksResult {
  applied: string[];
  skipped: string[];
  replayed: boolean;
}

/** POST /master-plan/apply 的响应（Go applyFromContentMasterPlanResponse）。 */
export interface ApplyMasterPlanResponse {
  success: boolean;
  initial_weeks?: InitialWeeksResult;
  plan: CurrentSeasonPlan;
  plan_id: string;
  /** 被替换的旧 active 计划 id；首次应用为 null。 */
  replaced_plan_id: string | null;
}

/** 应用时的替换确认（#537 预检的当前计划身份；无当前计划时省略）。 */
export interface MasterPlanReplacementExpectation {
  expected_active_plan_id: string;
  expected_active_revision: number;
}

/**
 * 应用一版训练计划（#585 卡片 CTA，apply-from-content）：服务端校验内容、
 * 事务内 supersede 旧 active 并写入新 active。apply_token 幂等——同一 token
 * 重放返回既有结果，不产生第二份计划。409 master_plan_exists = 有 active 但
 * 未带替换确认；409 master_plan_changed = 确认的身份已过期；422 = 内容无效。
 */
export function applyMasterPlanFromContent(
  applyToken: string,
  content: Record<string, unknown>,
  expectation?: MasterPlanReplacementExpectation,
): Promise<ApplyMasterPlanResponse> {
  return http.post<ApplyMasterPlanResponse>('/api/users/me/master-plan/apply', {
    apply_token: applyToken,
    content,
    ...(expectation
      ? {
          expected_active_plan_id: expectation.expected_active_plan_id,
          expected_active_revision: expectation.expected_active_revision,
        }
      : {}),
  });
}
