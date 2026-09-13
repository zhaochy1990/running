import { type CoachAgentConfig, createCoachAgent, type DataProvider } from "@stride/coach-agent";
import type { Persistence } from "../persistence/index.js";

/**
 * One LangGraph stream chunk: `[stream_mode, payload]`. The adapter requests
 * `stream_mode: ["messages", "values"]` on the plain graph:
 * - `messages` payloads are `[message, metadata]` tuples (AI/tool messages).
 * - `values` payloads are full state snapshots (the last is the final state).
 */
export interface CoachStreamSource {
  events: AsyncIterable<readonly [string, unknown]>;
}

export interface CoachInvoker {
  invoke(input: unknown, config: Record<string, unknown>): Promise<unknown>;
  streamEvents(input: unknown, config: Record<string, unknown>): Promise<CoachStreamSource>;
}

/** Minimal surface of the compiled coach graph the invoker drives. */
interface CoachGraph {
  invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
  stream(input: unknown, config?: Record<string, unknown>): Promise<AsyncIterable<readonly [string, unknown]>>;
}

export class CoachInvokerImpl implements CoachInvoker {
  private agent!: CoachGraph;
  private readonly dataProvider: DataProvider;
  private readonly coachConfig: CoachAgentConfig;
  private readonly persistence: Persistence;

  constructor(dataProvider: DataProvider, coachConfig: CoachAgentConfig, persistence: Persistence) {
    this.dataProvider = dataProvider;
    this.coachConfig = coachConfig;
    this.persistence = persistence;
  }

  invoke(input: unknown, invocationConfig: Record<string, unknown>) {
    return this.agent.invoke(input, invocationConfig);
  }

  async streamEvents(input: unknown, invocationConfig: Record<string, unknown>) {
    const events = await this.agent.stream(input, { ...invocationConfig, streamMode: ["messages", "values"] });
    return { events };
  }

  public async initialize(): Promise<void> {
    const coach = await createCoachAgent(this.dataProvider, this.coachConfig, {
      checkpointer: this.persistence.checkpointer,
      store: this.persistence.store,
    });
    this.agent = coach as unknown as CoachGraph;
  }
}
