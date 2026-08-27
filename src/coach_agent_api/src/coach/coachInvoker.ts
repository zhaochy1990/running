import { createCoachAgent, type CoachAgentConfig, type DataProvider } from "coach_agent";
import { type DeepAgent } from "deepagents";
import type { Persistence } from "../persistence/index.js";

export interface CoachInvoker {
  invoke(input: unknown, config: Record<string, unknown>): Promise<unknown>;
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

  public async initialize(): Promise<void> {
    const coach = await createCoachAgent(this.dataProvider, this.coachConfig, {
      checkpointer: this.persistence.checkpointer,
      store: this.persistence.store,
    });
    this.agent = coach;
  }
}
