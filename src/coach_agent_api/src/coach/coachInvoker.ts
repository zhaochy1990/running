import { type CoachAgentConfig, createCoachAgent, type DataProvider, getAgentConfig } from "@stride/coach-agent";
import type { Persistence } from "../persistence/index.js";
import { warnOnDegradedReply } from "../publicResponse.js";

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
  /** The qa role's output ceiling, i.e. the budget reasoning tokens also draw on. */
  private readonly maxOutputTokens: number;

  constructor(dataProvider: DataProvider, coachConfig: CoachAgentConfig, persistence: Persistence) {
    this.dataProvider = dataProvider;
    this.coachConfig = coachConfig;
    this.persistence = persistence;
    this.maxOutputTokens = getAgentConfig(coachConfig, "qa").max_tokens;
  }

  async invoke(input: unknown, invocationConfig: Record<string, unknown>) {
    const result = await this.agent.invoke(input, invocationConfig);
    warnOnDegradedReply(result, this.maxOutputTokens, this.turnContext(invocationConfig));
    return result;
  }

  async streamEvents(input: unknown, invocationConfig: Record<string, unknown>) {
    const events = await this.agent.stream(input, { ...invocationConfig, streamMode: ["messages", "values"] });
    return { events: this.watchForDegradedReply(events, invocationConfig) };
  }

  /**
   * Pass the event stream through untouched, keeping the last `values` snapshot
   * so the finished turn can be checked once the stream ends. Both chat paths
   * (sync and SSE) therefore share one place that notices a turn which completed
   * with no usable reply.
   */
  private async *watchForDegradedReply(
    events: AsyncIterable<readonly [string, unknown]>,
    invocationConfig: Record<string, unknown>,
  ): AsyncIterable<readonly [string, unknown]> {
    let lastState: unknown;
    for await (const chunk of events) {
      if (chunk[0] === "values") {
        lastState = chunk[1];
      }
      yield chunk;
    }
    warnOnDegradedReply(lastState, this.maxOutputTokens, this.turnContext(invocationConfig));
  }

  /** Turn identifiers to correlate a warning with the request that caused it. */
  private turnContext(invocationConfig: Record<string, unknown>): Record<string, unknown> {
    const configurable = invocationConfig.configurable;
    const metadata = invocationConfig.metadata;
    return {
      threadId: isRecord(configurable) ? configurable.thread_id : undefined,
      clientTurnId: isRecord(metadata) ? metadata.client_turn_id : undefined,
    };
  }

  public async initialize(): Promise<void> {
    const coach = await createCoachAgent(this.dataProvider, this.coachConfig, {
      checkpointer: this.persistence.checkpointer,
      store: this.persistence.store,
    });
    this.agent = coach as unknown as CoachGraph;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
