import { type CoachAgentConfig, createCoachAgent, type DataProvider } from "@stride/coach-agent";
import type { DeepAgent } from "deepagents";
import type { Persistence } from "../persistence/index.js";

/**
 * The minimal surface of a deepagents `streamEvents(..., { version: "v3" })`
 * run that the SSE adapter needs: the final state snapshot and the nested
 * subagent handles (each carrying its agent `name`).
 */
export interface CoachStreamSource {
  output: Promise<unknown>;
  subagents: AsyncIterable<{ name: string }>;
}

export interface CoachInvoker {
  invoke(input: unknown, config: Record<string, unknown>): Promise<unknown>;
  streamEvents(input: unknown, config: Record<string, unknown>): Promise<CoachStreamSource>;
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

  public async initialize(): Promise<void> {
    const coach = await createCoachAgent(this.dataProvider, this.coachConfig, {
      checkpointer: this.persistence.checkpointer,
      store: this.persistence.store,
    });
    this.agent = coach;
  }
}
