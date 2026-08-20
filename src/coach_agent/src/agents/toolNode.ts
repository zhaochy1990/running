import { AIMessage, type ToolMessage } from "@langchain/core/messages";
import type { GraphNode } from "@langchain/langgraph";
import type { AgentsState } from "./state.js";
// import { getToolByName } from "../tools/index.js";

export const toolNode: GraphNode<typeof AgentsState> = async (state) => {
  const lastMessage = state.messages.at(-1);

  if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
    return { messages: [] };
  }

  const result: ToolMessage[] = [];
  for (const toolCall of lastMessage.tool_calls ?? []) {
    // const tool = getToolByName(toolCall.name);
    // const observation = await tool.invoke(toolCall);
    // result.push(observation);
  }

  return { messages: result };
};
