// 训练调整 + 伤病模式 wire 类型（#858 PR-E）—— Go plan_adjustment.go /
// plan_injury.go 的 adjustmentDTO / injuryDTO 镜像，字段口径以后端为准：
// 与 types/plan.ts 同一约定（手工镜像、可空宽松，后端字段漂移不炸页面）。

/** 追问原因六选一（ADJUST_REASONS 单源枚举的镜像；injured 不走提案引擎）。 */
export type AdjustReason =
  | 'pace_unmet'
  | 'volume_unmet'
  | 'no_time'
  | 'injured'
  | 'ran_other'
  | 'over_delivered';

/** GET pending / POST choose 的行 DTO（adjustmentDTO 镜像）。 */
export interface PlanAdjustment {
  id: string;
  master_plan_id: string;
  /** 触发本次调整的偏差周（周一 YYYY-MM-DD）。 */
  event_week_start: string;
  /** 后端预判原因（弹窗默认选中，可改选）。 */
  reason: AdjustReason;
  status: string;
  /** payload JSON 字符串；null = 换因重生成中（轮询等待回填）。 */
  payload: string | null;
  /** 弹窗问句（后端润色，如「上周完成得不理想，主要是？」）。 */
  question: string;
  updated_at: string;
}

/**
 * plan_adjustment.payload 的结构（AdjustProposalPayload 镜像）。
 * weekly_docs 是完整 weekly-plan/v1 文档数组，mp 只消费 diff/窗口/审计行，
 * 应用（accept）由 Go 逐周 batch-apply，客户端不解析 weekly_docs。
 */
export interface AdjustProposalPayload {
  reason: AdjustReason;
  window: { start_week: number; end_week: number };
  weekly_docs: Array<Record<string, unknown>>;
  /** 新周文档 target km vs 现 weekly 行的对照。 */
  diff: Array<{ week: number; old_km: number; new_km: number }>;
  /** detector 一句话证据（Step1 副行直接展示）。 */
  evidence: string;
  /** Daniels 审计汇总（Step2 一行摘要）。 */
  audit_summary: { pass: number; warn: number; fail: number };
}

/** POST accept 的响应（applied 为逐周应用结果）。 */
export interface AcceptAdjustmentResponse {
  applied: Array<{ week_start: string; revision: number; replaced: boolean }>;
}

/** 伤病自判四选一（PlanInjuryVerdict 镜像）。 */
export type InjuryVerdict = 'continue' | 'reduced' | 'rest' | 'undecided';

/** 每日恢复轻问四键（PlanInjuryCheckin 镜像）。 */
export type InjuryCheckinAnswer = 'better' | 'same' | 'worse' | 'recovered';

/** GET plan-injury / enter·checkin·doctor 回读的行 DTO（injuryDTO 镜像）。 */
export interface PlanInjuryState {
  user_id: string;
  master_plan_id: string;
  /** reduced=维持课 / rest=完全停 / pending_doctor=看医生待定。 */
  mode: 'reduced' | 'rest' | 'pending_doctor';
  detail: string;
  maintenance_km: number | null;
  /** 加重后要求重新四选一（轻问问句切「伤有变化」。 */
  needs_verdict: boolean;
  last_checkin_day: string | null;
  last_checkin_answer: string | null;
}

/** enter / checkin / doctor 的联合响应：continue / recovered 会关模式。 */
export type InjuryMutationResult = { closed: true } | { closed: false; injury: PlanInjuryState };
