/**
 * set_activity_feel —— 教练对话式体感采集的落库工具（#508）。
 *
 * 体感是自由文本（可分段，如「前面4组体感6，最后两组7-8」）：运动员的原话
 * **原样**落库 `activities.feel_note`，不做数值映射、不改写、不总结——模型与
 * 下游分析直接读原文。厂商归一化的数字 feel 列（1–10）与本题无关，永不写入。
 *
 *   - `createActivityFeelTools(writer)` = 适配层，writer 走 Go API 的
 *     PATCH /api/{user}/activities/{labelId}（coach_agent_api 注入实现）。
 *
 * `userId` 来自 `runtime.context`，不是工具参数（见 src/coach_agent/AGENTS.md）。
 *
 * 防念叨纪律（与 analyze-activity skill 同一口径）：feel 与 feelNote 均已有值
 * （或任一有值）不调用；运动员婉拒或跑题后不再追问。已问标记暂走会话历史 +
 * skill 规则，未加额外状态——若实测仍出现重复追问，再落 checkpoint/Store 标记。
 */

import type { StructuredTool } from "@langchain/core/tools";
import * as z from "zod";
import type { CoachToolRuntime } from "../agents/coachAgent.js";
import { defineCoachTools } from "./common.js";

/** 体感写端口：coach_agent_api 侧经 Go API（x-internal-token）实现。 */
export interface ActivityFeelWriter {
  setActivityFeelNote(userId: string, labelId: string, feelNote: string): Promise<void>;
}

const setActivityFeelSchema = z.object({
  labelId: z.string().min(1).describe("运动记录的唯一 ID（labelId），取自 get_activities_by_date_range 或 get_activity_details 的返回。"),
  feelNote: z
    .string()
    // 先 trim 再校验/落库，与 Go handler 同序；否则全空白能过工具层、
    // 过不了 Go 判空，教练对话中途才 400。
    .trim()
    .min(1)
    // 按码点计数对齐 Go 侧 utf8.RuneCountInString ≤500；zod 的 .max 按 UTF-16
    // 码元计，含 emoji（代理对）时会比 Go 先拒绝。
    .refine((v) => [...v].length <= 500, "体感原话最多 500 字")
    .describe("运动员描述体感的原话，原样落库。不解析、不改写、不总结、不抽成数字——用户说了什么就传什么。"),
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
    await this.writer.setActivityFeelNote(userId, input.labelId, input.feelNote);
    return `已记录体感原话（labelId=${input.labelId}）。本次分析请立即使用该主观信号做交叉验证；此后对该活动不再询问体感。`;
  }
}

/**
 * Build the athlete-feel write tool with the Go API writer injected. Only the
 * qa agent mounts it（写入口受限：仅落库 feel_note 一列）。
 */
export function createActivityFeelTools(writer: ActivityFeelWriter): StructuredTool[] {
  const impl = new ActivityFeelToolImpl(writer);
  return defineCoachTools([
    {
      name: "set_activity_feel",
      description:
        "把运动员本次运动的主观体感原话（一句话或一段描述）落库。只在复盘某堂课、其 feel 与 feelNote 均为空、且运动员已回答后调用；" +
        "原话原样传入 feelNote，不解析不改写。feel 或 feelNote 已有值、或运动员婉拒/跑题时，绝不调用、也绝不再问。",
      schema: setActivityFeelSchema,
      handler: (input, runtime) => impl.setActivityFeel(input, runtime),
    },
  ]);
}
