import { AIMessage } from "@langchain/core/messages";
import { END, type GraphNode, START, StateGraph } from "@langchain/langgraph";
import { getLogger } from "@stride/common";
import { AgentsState } from "../state.js";

const logger = getLogger("coachAgent:training");

// ponytail: hello-world 占位节点，接入真实训练计划逻辑时整个换掉。
// 打印 message 正文只为本阶段调试；正式实现按 middleware.ts 的隐私约定只打元数据。
const helloNode: GraphNode<typeof AgentsState> = (state) => {
  logger.info({ userMessage: state.messages.at(-1)?.text ?? "" }, "training: hello world");
  return { messages: [new AIMessage("received")] };
};

/** 训练计划子图。当前只有一个 hello-world 节点，不调用 LLM。 */
export function createTrainingGraph() {
  return new StateGraph(AgentsState).addNode("hello", helloNode).addEdge(START, "hello").addEdge("hello", END).compile();
}
