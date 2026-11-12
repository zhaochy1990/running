import {
  createMasterPlanGraph,
  createMasterPlanLlmModels,
  DataProviderMasterPlanContextProvider,
  getAgentConfig,
  type loadConfig,
  type MasterPlanContextProvider,
  type MasterPlanLlmModels,
} from "@stride/coach-agent";
import type { MySqlDataProvider } from "../data/mysqlDataProvider.js";
import { type MasterPlanGraphShim, toMasterPlanGraphShim } from "../kernel/master/kernel.js";

/**
 * Per-job-type graph construction (business logic kept out of `main.ts`).
 */

/** master 与 rolling 共用的 LLM 装配（rolling 只 Pick phasing/content 两件）。 */
export function masterLlmModels(coachConfig: ReturnType<typeof loadConfig>): MasterPlanLlmModels {
  return createMasterPlanLlmModels({
    masterPlanModel: getAgentConfig(coachConfig, "master_plan"),
    phasingModel: getAgentConfig(coachConfig, "phasing"),
    contentModel: getAgentConfig(coachConfig, "master_plan"),
  });
}

export function masterPlanContextProvider(dataProvider: MySqlDataProvider): MasterPlanContextProvider {
  return new DataProviderMasterPlanContextProvider(dataProvider);
}

export function masterPlanGraph(coachConfig: ReturnType<typeof loadConfig>, dataProvider: MySqlDataProvider): MasterPlanGraphShim {
  const llmModels = masterLlmModels(coachConfig);
  return toMasterPlanGraphShim(createMasterPlanGraph({ contextProvider: masterPlanContextProvider(dataProvider), ...llmModels }));
}

/** 滚动 job 装配（#858）：与 master 图同款 provider + models（不重跑 L2，phasing 仅为装配形状保留）。 */
export function rollingDeps(
  coachConfig: ReturnType<typeof loadConfig>,
  dataProvider: MySqlDataProvider,
): {
  contextProvider: MasterPlanContextProvider;
  models: Pick<MasterPlanLlmModels, "phasingModel" | "contentModel">;
} {
  return { contextProvider: masterPlanContextProvider(dataProvider), models: masterLlmModels(coachConfig) };
}
