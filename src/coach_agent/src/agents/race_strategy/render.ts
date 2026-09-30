import { AIMessage } from "@langchain/core/messages";
import type { RaceStrategy } from "@stride/contract";
import { RaceStrategyDirectResponseSchema } from "@stride/contract";

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
 */
export function extractRaceStrategyResult(result: unknown): RaceStrategy | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const structured = (result as { structuredResponse?: unknown }).structuredResponse;
  if (structured === undefined) return undefined;
  const parsed = RaceStrategyDirectResponseSchema.safeParse(structured);
  return parsed.success ? parsed.data.content : undefined;
}

/** 结构化产物落进会话消息的形态（AIMessage，不再经任何模型改写）。 */
export function raceStrategyMessage(strategy: RaceStrategy): AIMessage {
  return new AIMessage({ content: renderRaceStrategyMarkdown(strategy) });
}
