/**
 * Long-term (cross-session) athlete memory tools, backed by the LangGraph Store.
 *
 * `getStore()` reads the store passed to `createDeepAgent({ store })`. Memories
 * are namespaced by userId, so they survive across threads/sessions (unlike the
 * checkpointer, which is per-thread conversation state).
 */

import { type ToolRuntime, tool } from "@langchain/core/tools";
import { getStore } from "@langchain/langgraph";
import * as z from "zod";
import type { CoachContext } from "./coachAgent.js";

const rememberSchema = z.object({
  note: z.string().describe("要长期记住的运动员目标/事实，例如“下个月想测10k看进步”"),
});

const rememberAthleteFact = tool(
  async (input, runtime: ToolRuntime<unknown, typeof CoachContext>) => {
    const userId = runtime.context?.userId;
    const note = input.note;

    const store = getStore();
    if (!store) throw new Error("remember_athlete_fact: no store configured");

    await store.put(["athlete_memory", userId], `${Date.now()}`, {
      note,
      savedAt: new Date().toISOString(),
    });

    return `已记住：${note}`;
  },
  {
    name: "remember_athlete_fact",
    description: "把运动员的长期目标/事实存入长期记忆（跨会话保留）",
    schema: rememberSchema,
  },
);

const recallSchema = z.object({});

const recallAthleteFacts = tool(
  async (_input, runtime: ToolRuntime<unknown, typeof CoachContext>) => {
    const store = getStore();
    if (!store) {
      throw new Error("recall_athlete_facts: no store configured");
    }

    const userId = runtime.context?.userId;
    const items = await store.search(["athlete_memory", userId]);
    const notes = items.map((i) => (i.value as { note?: string }).note).filter((n): n is string => Boolean(n));
    return notes.length > 0 ? notes.join("\n") : "（暂无长期记忆）";
  },
  {
    name: "recall_athlete_facts",
    description: "读取运动员之前记住的长期目标/事实",
    schema: recallSchema,
  },
);

export const memoryTools = [rememberAthleteFact, recallAthleteFacts];
