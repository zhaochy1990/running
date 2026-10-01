import { AIMessage } from "@langchain/core/messages";
import { type RaceStrategy, RaceStrategyDirectResponseSchema, RaceStrategySchema } from "@stride/contract";

/**
 * 把结构化策略渲染成会话里的 Markdown 初稿。会话流（mp-html 渲染 GFM）不保
 * 证支持表格，分段表用逐行列表；报告页（小程序）才是结构化视图，这里只需
 * 可读的初稿。
 */
export function renderRaceStrategyMarkdown(strategy: RaceStrategy): string {
  const lines: string[] = [];
  lines.push(`## ${strategy.race_name} · 比赛策略`);
  lines.push("");
  lines.push(`**目标成绩 ${strategy.target_finish_time}** —— ${strategy.summary}`);
  lines.push("");
  lines.push("**分段配速**");
  for (const segment of strategy.pace_segments) {
    lines.push(
      `- ${segment.segment}｜${segment.pace}｜本段 ${segment.segment_time}｜累计 ${segment.cumulative_time}${segment.note ? ` —— ${segment.note}` : ""}`,
    );
  }
  if (strategy.fueling_plan.length > 0) {
    lines.push("");
    lines.push("**补给计划**");
    for (const item of strategy.fueling_plan) {
      lines.push(`- ${item.time_point}｜${item.content}`);
    }
  }
  if (strategy.course_tips.length > 0) {
    lines.push("");
    lines.push("**赛道提示**");
    for (const tip of strategy.course_tips) lines.push(`- ${tip}`);
  }
  if (strategy.weather_tips.length > 0) {
    lines.push("");
    lines.push("**天气提示**");
    for (const tip of strategy.weather_tips) lines.push(`- ${tip}`);
  }
  if (strategy.basis_note) {
    lines.push("");
    lines.push(`> 依据：${strategy.basis_note}`);
  }
  return lines.join("\n");
}

/**
 * 从内层 agent 的返回里取已验证的策略信封。结构化输出未产生（教练声明依据
 * 不足、或纯追问）时返回 undefined，本轮按普通回复处理。
 *
 * 这里只做形状检查：structuredResponse 已在 ToolStrategy 解析和校验中间件
 * （失败即 throw）双层保证下到达此处，第三次 safeParse 是冗余防御。
 */
export function extractRaceStrategyResult(result: unknown): RaceStrategy | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredResponse?: unknown }).structuredResponse;
  if (typeof structured !== "object" || structured === null) return undefined;
  const envelope = structured as { disposition?: unknown; content?: unknown };
  if (envelope.disposition !== "return_direct") return undefined;
  if (typeof envelope.content !== "object" || envelope.content === null) return undefined;
  return envelope.content as RaceStrategy;
}

/** 结构化产物落进会话消息的形态（AIMessage，不再经任何模型改写）。 */
export function raceStrategyMessage(strategy: RaceStrategy): AIMessage {
  return new AIMessage({ content: renderRaceStrategyMarkdown(strategy) });
}

/**
 * 防御性信封解析：模型偶发不守 ToolStrategy 格式、把信封 JSON 当正文文本输出
 * （弱模型上已观察到），此函数把这类文本捞回成已验证的策略。只对「形似 JSON」
 * 的文本尝试（裸 `{` 开头或 ```json 围栏），safeParse 双口径（信封/裸对象），
 * 解析失败一律返回 undefined——按普通回复透传，绝不臆造。
 */
export function parseRaceStrategyFromText(text: string): RaceStrategy | undefined {
  const stripped = stripJsonFence(text).trim();
  if (stripped.length === 0 || !stripped.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  const envelope = RaceStrategyDirectResponseSchema.safeParse(parsed);
  if (envelope.success) return envelope.data.content;
  const bare = RaceStrategySchema.safeParse(parsed);
  return bare.success ? bare.data : undefined;
}

/** 文本里的 ```json 围栏剥离（信封泄漏的另一种形态），非围栏文本原样返回。 */
export function stripJsonFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  return match?.[1] ?? text;
}
