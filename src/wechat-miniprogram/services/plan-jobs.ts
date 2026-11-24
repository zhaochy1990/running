// 确定性计划 job 队列服务层（ADR 0030，coach_agent_api planJobs.ts）——
// #858 PR-E 消费 generate_adjustment（调整弹窗换因重生成通道）；
// #1024 消费 generate_master_plan（聊天表单卡确认后的赛季计划生成，异步
// worker 四层引擎，与 Admin 代生成同一队列）。
//
// 走 COACH_BASE_URL + JWT（me 路径，无 uid 注入）；请求体为
// { job_type, request, idempotency_key? }，request 经服务端 zod 严格复验
// （多余键会被拒）：adjust 见 @stride/contract AdjustJobRequest；master
// 见 MasterPlanGraphRequest（goals/availability/user_confirmations 全量，
// confirmations 必须全真——表单提交即确认）。

import { http } from './request';
import { COACH_BASE_URL } from '../constants/config';
import type { AdjustReason } from '../types/adjustment';

/** POST /api/users/me/coach/plan-jobs 的响应（201）。 */
export interface PlanJobEnqueueResponse {
  job_id: string;
  job_type: string;
  estimated_duration_seconds: number;
}

/** GET plan-jobs/:id 的轮询响应（Go/TS jobs 契约投影）。 */
export interface PlanJobPollResponse {
  job_id: string;
  job_type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: string;
  progress_pct: number;
  error_code: string | null;
  /** done 时为完整 result_json（content/user_id/revision/…），服务端按原始
   *  JSON **字符串**下发（coach_agent_api toPollResponse 直出 job.resultJson）；
   * 其余为 null。解析走 utils/planJobCards.planJobResultContent。 */
  result_json: string | Record<string, unknown> | null;
}

/** 随机 id（request_id / idempotency_key 共用）：服务端只要求非空字符串，
 *  前缀便于日志排障。 */
export function randomRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 换因重生成：choose 异因（payload 已被清空）后触发。worker 重跑调整投影并
 * 经内部端点回填 pending 行 payload——mp 轮询 pending 直到 payload 恢复。
 */
export function enqueueGenerateAdjustment(input: {
  eventWeekStart: string;
  reason: Exclude<AdjustReason, 'injured'>;
  masterPlanId?: string;
}): Promise<PlanJobEnqueueResponse> {
  return http.post<
    PlanJobEnqueueResponse,
    {
      job_type: 'generate_adjustment';
      request: {
        request_id: string;
        event_week_start: string;
        reason: Exclude<AdjustReason, 'injured'>;
        master_plan_id?: string;
      };
    }
  >(`${COACH_BASE_URL}/api/users/me/coach/plan-jobs`, {
    job_type: 'generate_adjustment',
    request: {
      request_id: randomRequestId('adj'),
      event_week_start: input.eventWeekStart,
      reason: input.reason,
      ...(input.masterPlanId ? { master_plan_id: input.masterPlanId } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// #1024：聊天表单卡确认 → generate_master_plan（异步 worker 四层引擎）
// ---------------------------------------------------------------------------

/** 表单卡提交的 kernel request 形状（MasterPlanGraphRequest 的 mp 侧最小镜像）。
 * 目标成绩二选一：`target_time` 为 null 时 `finish_only` 必须 true（zod
 * superRefine 的 XOR 口径），反之亦然。 */
export interface MasterPlanJobRequest {
  request_id: string;
  requested_mode: 'new_season';
  requested_modifiers: string[];
  goals: Array<{
    race_name: string;
    distance: 'FM' | 'HM';
    race_date: string;
    target_time: string | null;
    finish_only: boolean;
    priority: 'A';
  }>;
  availability: {
    weekly_run_days_max: number;
    available_training_windows: Array<Record<string, string>>;
    unavailable_days: string[];
    allows_double_sessions: boolean;
    preferred_long_run_day: string | null;
    strength_sessions_per_week: number;
    strength_available_days: string[];
  };
  injury_declarations: Array<Record<string, string>>;
  environment_constraints: string[];
  travel_constraints: string[];
  preferences: string[];
  prohibited_arrangements: string[];
  active_plan_action: 'none';
  user_confirmations: {
    intake_complete: true;
    goals_confirmed: true;
    availability_confirmed: true;
    injury_history_confirmed: true;
    constraints_confirmed: true;
  };
  requested_as_of?: string;
}

/**
 * 聊天表单卡确认 → 投 generate_master_plan（异步 worker 四层引擎，与 Admin
 * 代生成同队列）。idempotency_key 由调用方生成（幂等防重复投递）；服务端
 * zod 严格复验——confirmations 必须全真（表单提交即确认，R2）。
 */
export function enqueueGenerateMasterPlan(input: {
  request: MasterPlanJobRequest;
  idempotencyKey: string;
}): Promise<PlanJobEnqueueResponse> {
  return http.post<
    PlanJobEnqueueResponse,
    { job_type: 'generate_master_plan'; request: MasterPlanJobRequest; idempotency_key: string }
  >(`${COACH_BASE_URL}/api/users/me/coach/plan-jobs`, {
    job_type: 'generate_master_plan',
    request: input.request,
    idempotency_key: input.idempotencyKey,
  });
}

/** 轮询一个 plan job（owner 校验：me 路径只能看到自己的单）。 */
export function pollPlanJob(jobId: string): Promise<PlanJobPollResponse> {
  return http.get<PlanJobPollResponse>(
    `${COACH_BASE_URL}/api/users/me/coach/plan-jobs/${encodeURIComponent(jobId)}`,
  );
}
