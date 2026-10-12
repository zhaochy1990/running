/**
 * set_activity_feel —— 教练对话式体感采集的落库工具（#508）。
 *
 * 分层与其他工具一致：
 *   - 纯函数 `mapFeelUtterance` / `feelBand` = 语言→0–10 RPE 的映射口径（有单测），
 *     在工具内做交叉校验：模型拟写入的分值与运动员原话映射出的区间不一致时拒绝
 *     落库并要求先确认，防止模型口误把「轻松」写成 8。
 *   - `createActivityFeelTools(writer)` = 适配层，writer 走 Go API 的
 *     PATCH /api/{user}/activities/{labelId}（coach_agent_api 注入实现）。
 *
 * `userId` 来自 `runtime.context`，不是工具参数（见 src/coach_agent/AGENTS.md）。
 *
 * 防念叨纪律（与 analyze-activity skill 同一口径）：feel 已有值不调用；运动员婉拒
 * 或跑题后不再追问。已问标记暂走会话历史 + skill 规则，未加额外状态——若实测仍
 * 出现重复追问，再落 checkpoint/Store 标记。
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import { defineCoachTools } from "./common.js";

/** 体感写端口：coach_agent_api 侧经 Go API（x-internal-token）实现。 */
export interface ActivityFeelWriter {
  setActivityFeel(userId: string, labelId: string, feel: number): Promise<void>;
}

/** RPE 说话测试量表的连续分档（0｜1–2｜3–4｜5–6｜7｜8｜9｜10）。 */
export type FeelBand = readonly [lo: number, hi: number];

/** 把分值归到量表分档（0｜1–2｜3–4｜5–6｜7｜8｜9｜10）；越界返回 null。 */
export function feelBand(value: number): FeelBand | null {
  if (!Number.isFinite(value) || value < 0 || value > 10) return null;
  if (value < 1) return [0, 0] as const;
  if (value <= 2) return [1, 2] as const;
  if (value <= 4) return [3, 4] as const;
  if (value <= 6) return [5, 6] as const;
  return [Math.round(value), Math.round(value)] as const; // 7 | 8 | 9 | 10 单点档
}

/**
 * 运动员原话 → 0–10 RPE 分档（口径与 analyze-activity skill 一致）。
 * 返回 null 表示没有命中或命中横跨多个分档（歧义，交给模型判断）。
 * 「N 成力」「N–M 成力」按 RPE 本义直接映射 N / N–M。
 *
 * ponytail: 裸子串匹配有已知误报（「配速冲刺到430」→10、「呼吸不喘」→7），
 * 分值档位 Math.round 半值偏重（6.5→7）；两者都靠「复述确认再落库」的对话环
 * 兜底，实测出现真实误写再上否定/语境防护。
 */
export function mapFeelUtterance(text: string): FeelBand | null {
  // 成力表述优先：「7-8 成力」→ [7,8]；「6 成力」→ [6,6]。
  const chengli = text.match(/(\d{1,2})(?:\s*[-–~到]\s*(\d{1,2}))?\s*成/);
  if (chengli) {
    const lo = Number(chengli[1]);
    const hi = chengli[2] !== undefined ? Number(chengli[2]) : lo;
    if (lo >= 0 && hi >= lo && hi <= 10) return [lo, hi] as const;
  }

  const bands: Array<{ keywords: string[]; band: FeelBand }> = [
    { keywords: ["全力", "冲刺"], band: [10, 10] },
    { keywords: ["接近极限", "快崩了", "几乎崩", "崩了", "要炸"], band: [9, 9] },
    { keywords: ["很吃力", "非常吃力", "说不出话", "喘得说不出", "只能说一两个词"], band: [8, 8] },
    { keywords: ["散步", "非常轻松", "很轻松", "跟走一样"], band: [1, 2] },
    { keywords: ["吃力", "费劲", "喘"], band: [7, 7] },
    { keywords: ["马拉松配速", "马拉松节奏", "有点强度", "还行", "还可以", "中等"], band: [5, 6] },
    { keywords: ["轻松", "不累", "恢复跑", "很慢的慢跑"], band: [3, 4] },
  ];

  // 按特异性优先序取第一个命中的分档（「非常轻松」归 1–2 而非泛化的「轻松」3–4，
  // 「很吃力」归 8 而非「吃力」7）。混合表述（「轻松但后面吃力」）取先命中的更重档，
  // 校验不过时工具会要求模型与运动员确认。
  for (const { keywords, band } of bands) {
    if (keywords.some((k) => text.includes(k))) return band;
  }
  return null;
}

/** 模型拟写入的分值是否与原话映射出的分档相容（区间不相交 = 需先确认）。 */
export function feelBandDisagrees(value: number, band: FeelBand): boolean {
  const valueBand = feelBand(value);
  if (!valueBand) return true;
  return valueBand[1] < band[0] || valueBand[0] > band[1];
}

const setActivityFeelSchema = z.object({
  labelId: z.string().min(1).describe("运动记录的唯一 ID（labelId），取自 get_activities_by_date_range 或 get_activity_details 的返回。"),
  feel: z.number().min(0).max(10).describe("主观体感，0–10 RPE 量表（说话测试锚点见 skill）。描述性回答先映射并复述确认，再传确认后的数值。"),
  sourceUtterance: z.string().optional().describe("运动员描述体感的原话（如「挺轻松」「7-8 成力」）。传入后会做量表交叉校验，与分值明显不符时拒绝落库。"),
});

type SetActivityFeelInput = z.infer<typeof setActivityFeelSchema>;

/** Domain interface — pure business logic, decoupled from LangChain. */
interface ActivityFeelTool {
  setActivityFeel(input: SetActivityFeelInput, runtime: CoachToolRuntime): Promise<string>;
}

class ActivityFeelToolImpl implements ActivityFeelTool {
  constructor(private readonly writer: ActivityFeelWriter) {}

  async setActivityFeel(input: SetActivityFeelInput, runtime: CoachToolRuntime): Promise<string> {
    const userId = runtime.context?.userId;
    if (!userId) {
      throw new Error("set_activity_feel: missing userId in runtime context");
    }
    // 交叉校验：原话可明确映射到某一档、而拟写入分值在另一档 → 不落库。
    if (input.sourceUtterance) {
      const band = mapFeelUtterance(input.sourceUtterance);
      if (band && feelBandDisagrees(input.feel, band)) {
        return (
          `未落库：运动员原话「${input.sourceUtterance}」按 0–10 量表映射为 ${band[0]}–${band[1]}，` +
          `与拟写入的 ${input.feel} 不在同一分档。请向运动员复述确认（如「听起来是 ${Math.round((band[0] + band[1]) / 2)}，对吗？」）后再调用本工具。`
        );
      }
    }
    await this.writer.setActivityFeel(userId, input.labelId, input.feel);
    return `已记录体感 ${input.feel}/10（labelId=${input.labelId}）。本次分析请立即使用该主观信号做交叉验证；此后对该活动不再询问体感。`;
  }
}

/**
 * Build the athlete-feel write tool with the Go API writer injected. Only the
 * qa agent mounts it（写入口受限：仅落库 feel，一列）。
 */
export function createActivityFeelTools(writer: ActivityFeelWriter): StructuredTool[] {
  const impl = new ActivityFeelToolImpl(writer);
  return defineCoachTools([
    {
      name: "set_activity_feel",
      description:
        "把运动员本次运动的主观体感（0–10 RPE）落库。只在复盘某堂课、其 feel 为空、且运动员已用一句话回答（数值或描述）后调用；" +
        "描述性回答先按量表映射并向运动员复述确认，再带着 sourceUtterance（原话）调用。feel 已有值、或运动员婉拒/跑题时，绝不调用、也绝不再问。",
      schema: setActivityFeelSchema,
      handler: (input, runtime) => impl.setActivityFeel(input, runtime),
    },
  ]);
}
