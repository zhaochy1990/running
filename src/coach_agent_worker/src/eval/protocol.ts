/**
 * 测评 worker ↔ 测评 API 的线上契约（devops#1055）。Go 侧实现在
 * `src/go/internal/planeval`；字段名两边逐一对应，改动须同步。
 */

/** 投递到版本队列的指针消息：只带格式版本与执行项 ID，冻结输入经内部 API 领取。 */
export interface EvalExecutionMessage {
  schema_version: 1;
  snapshot_execution_id: string;
}

export const EVAL_MESSAGE_SCHEMA_VERSION = 1;

export interface ExecutionInput {
  artifact_type: "master_plan";
  /** 冻结的生成请求（MasterPlanGraphRequest 的 JSON）。 */
  request: unknown;
  /** 冻结的 RunnerSnapshot（plan-eval-runner-snapshot/v1）。 */
  snapshot: unknown;
  /** 执行时点，带时区偏移的 ISO 8601；Generate 与 Evaluate 共用。 */
  as_of: string;
}

/** Generate 终态：一份产物原文，或一个结构化错误（二者必居其一）。 */
export type GenerateResult = { kind: "artifact"; artifact_type: "master_plan"; content: string } | { kind: "failed"; error: { code: string; message: string } };

export type ClaimResponse =
  | { status: "leased"; lease_epoch: number; lease_expires_at: string; input: ExecutionInput }
  /** 别的 worker 持有有效租约：保持消息未确认，等这么久后再领取。 */
  | { status: "busy"; retry_after_ms: number }
  /** Generate 已终结：直接确认消息，不再生成。 */
  | { status: "terminal"; generate_status: "done" | "failed"; artifact_id: string | null }
  /** 执行项不存在（行已清理或消息投错队列）：丢弃消息。 */
  | { status: "missing" };

/** 持久化确认（收据）：worker 拿到它才 ACK；同一终态重发返回同一份。 */
export interface GenerateReceipt {
  receipt_id: string;
  snapshot_execution_id: string;
  generate_status: "done" | "failed";
  artifact_id: string | null;
  evaluate_status: string;
  received_at: string;
}
