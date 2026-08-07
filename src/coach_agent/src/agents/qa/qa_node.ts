/**
 * QA path — the qaNode (ReAct LLM step).
 *
 * A training-question specialist: an LLM with the read-only QA tools bound. Each
 * turn it either emits tool calls (need more data) or writes the final answer
 * (no tool calls → the graph ends). This is the ReAct loop's "brain"; it also
 * self-finalizes — there is no separate answer node.
 */

import { SystemMessage } from "@langchain/core/messages";
import { Command, END, type GraphNode } from "@langchain/langgraph";
import type { ModelConfig } from "../../config/config.js";
import { getLogger } from "../../logging/index.js";
import { buildResponsesModel } from "../common.js";
import type { AgentsState } from "../state.js";

const logger = getLogger("qa");

const QA_SYSTEM_PROMPT = [
  "你是 STRIDE 跑步教练。运动员会问关于自己训练的问题（例如“我今天跑的怎么样？”）。",
  "工作方式：",
  "- 先用工具查所需数据（今天这跑 get_run_today、当天原计划 get_scheduled_session、负荷影响 get_training_load_impact），再据实回答。",
  "- 需要哪个数据就调哪个工具；数据够了就直接回答，不要过度调用。",
  "- 回答面向运动员本人：具体、简洁，给出训练解读（练得对不对、对负荷/恢复的影响），必要时补一句可执行建议。",
  "- 只依据工具返回的数据说话；工具没给的数据不要编。",
].join("\n");

/** Build the qaNode from a Responses model config (agent role "qa"). */
export function getQaNode(modelConfig: ModelConfig, toolsNode = "executeTools"): GraphNode<typeof AgentsState> {
  const model = buildResponsesModel(modelConfig);
  // const modelWithTools = model.bindTools(qaTools);

  const node: GraphNode<typeof AgentsState> = async (state) => {
    // userId lives on the state channel, not in the messages — surface it so the
    // model passes it to the tools.
    const system = `${QA_SYSTEM_PROMPT}\n\n当前运动员 userId=${state.userId}；调用工具时用这个 userId。`;

    const response = await model.invoke([
      new SystemMessage(system),
      ...state.messages,
    ]);

    const toolCalls = response.tool_calls ?? [];
    logger.debug({ toolCalls: toolCalls.map((c) => c.name) }, "qa turn");

    // ReAct: asked for tools → run them; otherwise this message IS the answer → END.
    const goto = toolCalls.length > 0 ? toolsNode : END;
    return new Command({ update: { messages: [response], llmCalls: 1 }, goto });
  };

  return node;
}
