import { type CoachAgentConfig, createCoachAgent, type DataProvider } from "@stride/coach-agent";
import type { DeepAgent } from "deepagents";
import type { Persistence } from "../persistence/index.js";

/**
 * The minimal surface of a deepagents `streamEvents(..., { version: "v3" })`
 * run that the SSE adapter needs. Each projection mirrors the langgraph v3
 * projection of the same name, narrowed to the fields the stream maps:
 *
 * - `messages` — the outer agent's AI message lifecycles; `text` yields
 *   per-token deltas, and the final text is the reply (L1).
 * - `toolCalls` — tool invocations with a `status` that resolves to the call's
 *   terminal state so the adapter can emit a matching end event (L2).
 * - `subagents` — nested agent invocations; their tools / delegates feed L2
 *   status (their own messages are an intermediate tool result, not the reply).
 * - `output` — the final state, mapped to the `done` event.
 */
export interface CoachStreamSource extends CoachStreamNode {
  output: Promise<unknown>;
  messages: AsyncIterable<CoachStreamMessage>;
}

/** One AI message lifecycle: `text` yields incremental text deltas. */
export interface CoachStreamMessage {
  text: AsyncIterable<string>;
}

/** One tool invocation; `status` resolves when the call leaves `"running"`. */
export interface CoachStreamToolCall {
  name: string;
  status: Promise<ToolCallStatus>;
}

export type ToolCallStatus = "running" | "finished" | "error";

/** The L2 status surface shared by the root run and its nested subagents. */
export interface CoachStreamNode {
  toolCalls: AsyncIterable<CoachStreamToolCall>;
  subagents: AsyncIterable<CoachStreamSubagent>;
}

/** A nested agent invocation (e.g. the QA subagent) and its own L2 projections. */
export interface CoachStreamSubagent extends CoachStreamNode {
  name: string;
}

export interface CoachInvoker {
  invoke(input: unknown, config: Record<string, unknown>): Promise<unknown>;
  streamEvents(input: unknown, config: Record<string, unknown>): Promise<CoachStreamSource>;
  /**
   * Append a message to an existing thread without running any graph node
   * (ADR 0030: the chat layer writes the plan-job confirmation message).
   * Backed by LangGraph `updateState`, so the message flows through the
   * messages-channel reducer and lands in the checkpointer.
   */
  appendThreadMessage(threadId: string, message: unknown): Promise<void>;
}

export class CoachInvokerImpl implements CoachInvoker {
  private agent!: DeepAgent;
  private readonly dataProvider: DataProvider;
  private readonly coachConfig: CoachAgentConfig;
  private readonly persistence: Persistence;

  constructor(dataProvider: DataProvider, coachConfig: CoachAgentConfig, persistence: Persistence) {
    this.dataProvider = dataProvider;
    this.coachConfig = coachConfig;
    this.persistence = persistence;
  }

  invoke(input: unknown, invocationConfig: Record<string, unknown>) {
    return this.agent.invoke(input as never, invocationConfig as never);
  }

  streamEvents(input: unknown, invocationConfig: Record<string, unknown>) {
    const v3Config = { ...invocationConfig, version: "v3" as const };
    return this.agent.streamEvents(input as never, v3Config as never);
  }

  appendThreadMessage(threadId: string, message: unknown) {
    // ReactAgent marks updateState `@internal`/`never` in its type surface, but
    // the compiled graph exposes the standard LangGraph updateState at runtime.
    const updateState = (
      this.agent as unknown as {
        updateState(config: Record<string, unknown>, values: Record<string, unknown>): Promise<unknown>;
      }
    ).updateState.bind(this.agent);
    return updateState({ configurable: { thread_id: threadId } }, { messages: [message] }) as Promise<void>;
  }

  public async initialize(): Promise<void> {
    const coach = await createCoachAgent(this.dataProvider, this.coachConfig, {
      checkpointer: this.persistence.checkpointer,
      store: this.persistence.store,
    });
    this.agent = coach;
  }
}
