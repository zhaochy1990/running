import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  type CustomWorkoutCard,
  CustomWorkoutLenientContentSchema,
  CustomWorkoutLenientDirectResponseSchema,
  normalizeCustomWorkoutDraft,
  renderRunWorkoutSummary,
} from "@stride/contract";

/** 节点确定性补齐标量后的卡片草稿（date/name/summary/spec 已 normalize）。 */
export type NormalizedCustomWorkoutDraft = ReturnType<typeof normalizeCustomWorkoutDraft>;

/**
 * 把结构化卡片渲染成会话里的 Markdown 初稿：课表压缩文案（renderRunWorkoutSummary
 * 确定性渲染）+ 一句建议；不重排 spec 细节——卡片与今日页才是结构化视图。
 */
export function renderCustomWorkoutMarkdown(card: CustomWorkoutCard): string {
  const lines: string[] = [];
  lines.push(`## ${card.date} · ${card.name}`);
  lines.push("");
  lines.push(card.summary);
  lines.push("");
  lines.push(`\`${renderRunWorkoutSummary(card.spec)}\``);
  if (card.advice) {
    lines.push("");
    lines.push(`> ${card.advice}`);
  }
  return lines.join("\n");
}

/**
 * 结构化产物落进会话消息的形态（AIMessage，不经任何模型改写）。card 信封挂
 * 消息自身（additional_kwargs）随 checkpoint 持久化——done/历史投影按消息读，
 * 跨轮、跨重启保真（与 race-strategy/master-plan 同机制）。
 */
export function customWorkoutCardMessage(card: CustomWorkoutCard): AIMessage {
  return new AIMessage({
    content: renderCustomWorkoutMarkdown(card),
    additional_kwargs: { card: { $type: "custom-workout", data: card } },
  });
}

/**
 * 从内层 agent 的返回里取已 normalize 的草稿信封。结构化输出未产生（缺日期
 * 追问、说明）时返回 undefined。structuredResponse 已在 ToolStrategy 解析和
 * 校验中间件双层保证下到达此处，safeParse 是防御性二次确认。
 */
export function extractCustomWorkoutDraft(result: unknown): NormalizedCustomWorkoutDraft | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredResponse?: unknown }).structuredResponse;
  if (typeof structured !== "object" || structured === null) return undefined;
  const envelope = CustomWorkoutLenientDirectResponseSchema.safeParse(structured);
  return envelope.success ? normalizeCustomWorkoutDraft(envelope.data.content) : undefined;
}

/**
 * 防御性信封解析：模型偶发不守 ToolStrategy 格式、把信封 JSON 当正文文本输出
 * （弱模型上 race_strategy/master_plan 已观察到同款行为）。只对形似信封或裸
 * 草稿对象的文本尝试（```json 围栏先剥），safeParse 双口径，解析失败一律
 * undefined——按普通回复透传，绝不臆造。
 */
export function parseCustomWorkoutFromText(text: string): NormalizedCustomWorkoutDraft | undefined {
  const stripped = stripJsonFence(text).trim();
  if (stripped.length === 0 || !stripped.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  const envelope = CustomWorkoutLenientDirectResponseSchema.safeParse(parsed);
  if (envelope.success) return normalizeCustomWorkoutDraft(envelope.data.content);
  const bare = CustomWorkoutLenientContentSchema.safeParse(parsed);
  return bare.success ? normalizeCustomWorkoutDraft(bare.data) : undefined;
}

/** 文本里的 ```json 围栏剥离（信封泄漏的另一种形态），非围栏文本原样返回。 */
function stripJsonFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return match?.[1] ?? text;
}

/** 扫描本轮新增 AI 文本，命中防御解析即捞回（见 parseCustomWorkoutFromText）。 */
export function leakedCustomWorkoutFromText(result: { messages: BaseMessage[] }, state: { messages: BaseMessage[] }): NormalizedCustomWorkoutDraft | undefined {
  const delta = result.messages.slice(state.messages.length);
  for (let index = delta.length - 1; index >= 0; index -= 1) {
    const message = delta[index];
    if (message === undefined || message.getType() !== "ai" || typeof message.content !== "string") continue;
    if (!message.content.trimStart().startsWith("{") && !message.content.includes("```json")) continue;
    const draft = parseCustomWorkoutFromText(message.content);
    if (draft !== undefined) return draft;
  }
  return undefined;
}
