/**
 * ask_user_question —— 通用的“向用户追问”能力（human-in-the-loop）。
 *
 * 当 agent 无法仅凭数据得出可靠结论、必须让运动员本人澄清时调用它。工具内部用
 * LangGraph 的 {@link interrupt} 暂停整张图，把问题（含可选候选项）抛给调用方
 * （CLI / 前端 / 上层 harness）；调用方拿到用户回答后用 `Command({ resume })`
 * 恢复，回答会作为工具结果回到模型手里。
 *
 * 关键点：
 *   - 依赖 checkpointer（thread 级）才能暂停/恢复 —— coach agent 已配置。
 *   - 可从子专家内部调用：interrupt 会穿过 `task` 委派冒泡到顶层 invoke（已实测）。
 *   - 是纯交互动作，不读 `runtime.context`，因此用最朴素的 `tool(...)` 定义。
 *
 * interrupt 抛出的 payload 形如：
 * ```json
 * { "kind": "ask_user_question", "question": "...", "header": "...",
 *   "options": [{ "label": "腿部抽筋", "description": "..." }], "allowMultiple": false }
 * ```
 * resume 值可为字符串（自由作答）或字符串数组（多选的 label）。
 */

import { interrupt } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import * as z from "zod";

/** interrupt payload 的判别字段 —— 调用方据此识别“这是一次向用户的追问”。 */
export const ASK_USER_QUESTION_KIND = "ask_user_question";

const optionSchema = z.object({
  label: z.string().describe("候选答案的简短文字，如“腿部抽筋”"),
  description: z.string().optional().describe("对该候选答案的补充说明"),
});

const askUserQuestionSchema = z.object({
  question: z.string().describe("要向运动员提出的完整、具体的问题"),
  header: z.string().optional().describe("问题的简短标题（可选，≤ 12 字）"),
  options: z.array(optionSchema).optional().describe("建议的候选答案（可选）；即使给了候选项，运动员仍可自由作答"),
  allowMultiple: z.boolean().optional().describe("是否允许运动员选择多个候选项，默认 false"),
});

/** interrupt 抛给调用方的结构（供 CLI/前端渲染追问界面）。 */
export interface AskUserQuestionPayload {
  kind: typeof ASK_USER_QUESTION_KIND;
  question: string;
  header: string | null;
  options: Array<{ label: string; description?: string | undefined }>;
  allowMultiple: boolean;
}

/**
 * 通用追问工具。任何需要 human-in-the-loop 的 agent / 子专家都可挂载它。
 *
 * @example
 * ```ts
 * tools: [...planTools, askUserQuestionTool]
 * ```
 */
export const askUserQuestionTool = tool(
  (input: z.infer<typeof askUserQuestionSchema>) => {
    const payload: AskUserQuestionPayload = {
      kind: ASK_USER_QUESTION_KIND,
      question: input.question,
      header: input.header ?? null,
      options: input.options ?? [],
      allowMultiple: input.allowMultiple ?? false,
    };
    // 暂停整张图，等待调用方 Command({ resume }) 注入用户回答。
    const answer = interrupt(payload) as unknown;
    const text = Array.isArray(answer) ? answer.map((a) => String(a)).join("；") : String(answer ?? "");
    return `运动员的回答：${text || "（未作答）"}`;
  },
  {
    name: "ask_user_question",
    description:
      "当你无法仅凭现有数据得出可靠结论、需要运动员本人澄清时，用它向运动员追问一个问题并等待回答。" +
      "可给出候选答案 options（每项 label + 可选 description）帮助运动员作答，运动员也可自由回答。" +
      "典型场景：数据显示某次比赛异常（如跑崩/严重掉速），但真正原因（心肺、抽筋、补给、配速策略等）无法从数据判断时，向运动员追问当时的具体情况。" +
      "一次只问一个核心问题，问题要具体。",
    schema: askUserQuestionSchema,
  },
);
