import { AIMessage } from "@langchain/core/messages";

/**
 * `workout-op` 确认卡数据（devops#697，epic #669 三条流的删除/改期）：教练在对话
 * 里锁定目标课后出确认卡，客户端点 CTA 直调用户端点（删除走现有 DELETE
 * custom-workouts/:id，改期走 T1 的 POST …/:id/move）——coach 侧无内部写端点，
 * 模型误判不产生任何破坏性后果。信封随消息 checkpoint 持久化，coach_agent_api
 * cardFromMessage 只做形状检查透传（零网关改动）；旧版 mp 收到未知 $type 降级
 * markdown，天然向后兼容。
 */
export interface WorkoutOpCardData {
  /** delete=删除（现有软删端点）；move=改期（T1 move 端点）。 */
  op: "delete" | "move";
  workout_id: string;
  /** 目标课当前日期（YYYY-MM-DD）。 */
  date: string;
  /** move 的目标日期（YYYY-MM-DD）；delete 无此字段。 */
  new_date?: string;
  name: string;
  kind: string;
  summary?: string;
  /** 已推送到手表：卡片提示「已推送，删除/改期将同步手表」。 */
  pushed: boolean;
}

/** 确认话术（卡片正文；与卡片数据同源，避免文字与卡不一致）。 */
export function renderWorkoutOpText(data: WorkoutOpCardData): string {
  const action = data.op === "delete" ? `将删除 ${data.date} 的「${data.name}」。` : `将把 ${data.date} 的「${data.name}」改期到 ${data.new_date}。`;
  const watchNote = data.pushed ? "这节课已推送到手表，确认后会尽力同步更新手表上的副本。" : "";
  const cta = data.op === "delete" ? "请在下方卡片点击确认删除。" : "请在下方卡片点击确认改期。";
  return action + watchNote + cta;
}

/** 结构化确认卡消息（AIMessage，card 信封挂 additional_kwargs，与 custom-workout 卡同机制）。 */
export function workoutOpCardMessage(data: WorkoutOpCardData): AIMessage {
  return new AIMessage({
    content: renderWorkoutOpText(data),
    additional_kwargs: { card: { $type: "workout-op", data } },
  });
}
