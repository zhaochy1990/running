import {
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  createWeeklyPlanGeneratorGraph,
  DataProviderMasterPlanContextProvider,
  DataProviderWeeklyPlanContextProvider,
  getAgentConfig,
  type loadConfig,
} from "@stride/coach-agent";
import type { MySqlDataProvider } from "../data/mysqlDataProvider.js";
import { type MasterPlanGraphShim, toMasterPlanGraphShim } from "../kernel/master/kernel.js";
import { toWeeklyPlanGraphShim, type WeeklyPlanGraphShim } from "../kernel/weekly/kernel.js";

/**
 * Per-job-type graph construction (business logic kept out of `main.ts`).
 * The asymmetry is intentional: the master graph takes pre-built LLM models
 * (`createMasterPlanLlmModels`), while the weekly graph takes the coach config
 * directly and builds its own `weekly_plan` LLM internally.
 */

export function masterPlanGraph(coachConfig: ReturnType<typeof loadConfig>, dataProvider: MySqlDataProvider): MasterPlanGraphShim {
  const llmModels = createMasterPlanLlmModels({
    masterPlanModel: getAgentConfig(coachConfig, "master_plan"),
    phasingModel: getAgentConfig(coachConfig, "phasing"),
    contentModel: getAgentConfig(coachConfig, "master_plan"),
  });
  return toMasterPlanGraphShim(createMasterPlanGraph({ contextProvider: new DataProviderMasterPlanContextProvider(dataProvider), ...llmModels }));
}

export function weeklyPlanGraph(coachConfig: ReturnType<typeof loadConfig>, dataProvider: MySqlDataProvider): WeeklyPlanGraphShim {
  return toWeeklyPlanGraphShim(createWeeklyPlanGeneratorGraph(coachConfig, new DataProviderWeeklyPlanContextProvider(dataProvider)));
}
