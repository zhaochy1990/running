// 确定性计划 job 队列服务层（ADR 0030，coach_agent_api planJobs.ts）——
// #858 PR-E 只消费 generate_adjustment（调整弹窗换因重生成通道）。
//
// 走 COACH_BASE_URL + JWT（me 路径，无 uid 注入）；请求体为
// { job_type, request }，request 经服务端 zod 严格复验（多余键会被拒），字段
// 见 @stride/contract AdjustJobRequest：request_id（随机串）/ event_week_start
// （YYYY-MM-DD 周一）/ reason。mp 不带 create_pending（那是夜检通道标志）。

import { http } from './request';
import { COACH_BASE_URL } from '../constants/config';
import type { AdjustReason } from '../types/adjustment';
import type { CoachCardWire } from '../utils/coachCards';

/** POST /api/users/me/coach/plan-jobs 的响应（201）。 */
export interface PlanJobEnqueueResponse {
  job_id: string;
  job_type: string;
  estimated_duration_seconds: number;
}

/** 随机 request_id：服务端只要求非空字符串（幂等键另算），「adj-」前缀便于日志排障。 */
function randomRequestId(): string {
  return `adj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
      request_id: randomRequestId(),
      event_week_start: input.eventWeekStart,
      reason: input.reason,
      ...(input.masterPlanId ? { master_plan_id: input.masterPlanId } : {}),
    },
  });
}

/** 用户仅可读取本人任务；已完成的赛季候选卡片携带完整内容及稳定的 apply_token。 */
export interface PlanJobPollResponse {
  job_id: string;
  job_type: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  error_code: string | null;
  candidate_card?: CoachCardWire;
}

export function getPlanJob(jobId: string): Promise<PlanJobPollResponse> {
  return http.get<PlanJobPollResponse>(`${COACH_BASE_URL}/api/users/me/coach/plan-jobs/${encodeURIComponent(jobId)}`);
}
