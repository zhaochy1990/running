// 训练调整提案服务层（#858 PR-E）—— Go plan_adjustment.go 用户通道封装。
//
// 数据面走 API_BASE_URL + JWT self（路径 uid 必须是 JWT sub，服务端 selfOnly
// 校验）；404 语义为「当前没有待确认的调整」，getPendingAdjustment 归一为 null，
// 其余错误原样抛出由调用方区分（首页静默吞、计划页提示条隐藏）。

import { http, ApiError } from './request';
import type { AcceptAdjustmentResponse, AdjustReason, PlanAdjustment } from '../types/adjustment';

/** 拉当前用户的 pending 调整提案；无（404）返回 null。 */
export async function getPendingAdjustment(userId: string): Promise<PlanAdjustment | null> {
  try {
    const res = await http.get<{ adjustment: PlanAdjustment }>(
      `/api/users/${encodeURIComponent(userId)}/plan-adjustment/pending`,
    );
    return res.adjustment;
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * 回答追问原因。同因 200（payload 即出方案）；异因 202（payload 清空、
 * 重生成中）。两条路径响应体同为 adjustmentDTO——调用方以 payload 是否为
 * null 分流（null → 调 plan-jobs 换因重生成并轮询），无需读状态码。
 */
export async function chooseAdjustment(
  userId: string,
  adjustmentId: string,
  reason: AdjustReason,
): Promise<PlanAdjustment> {
  const res = await http.post<{ adjustment: PlanAdjustment }, { reason: AdjustReason }>(
    `/api/users/${encodeURIComponent(userId)}/plan-adjustments/${encodeURIComponent(adjustmentId)}/choose`,
    { reason },
  );
  return res.adjustment;
}

/** 同意调整：服务端在同一事务里整批应用 payload 的 weekly docs 并标记 accepted。 */
export function acceptAdjustment(
  userId: string,
  adjustmentId: string,
): Promise<AcceptAdjustmentResponse> {
  return http.post<AcceptAdjustmentResponse>(
    `/api/users/${encodeURIComponent(userId)}/plan-adjustments/${encodeURIComponent(adjustmentId)}/accept`,
  );
}

/** 保持原计划：关闭该调整事件（同一偏差周不再追问）。204 无响应体。 */
export async function dismissAdjustment(userId: string, adjustmentId: string): Promise<void> {
  await http.post(
    `/api/users/${encodeURIComponent(userId)}/plan-adjustments/${encodeURIComponent(adjustmentId)}/dismiss`,
  );
}
