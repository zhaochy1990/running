import { createMasterPlanGraph, createMasterPlanLlmModels, DataProviderMasterPlanContextProvider, getAgentConfig, loadConfig } from "@stride/coach-agent";
import { getLogger } from "@stride/common";
import { loadWorkerConfig } from "./config.js";
import { coachAgentConfigFiles, workerConfigFiles } from "./configPaths.js";
import { MySqlDataProvider } from "./data/mysqlDataProvider.js";
import { createPool, createStridePool, ensureDatabase } from "./db/mysql.js";
import { GoDraftClient } from "./goClient/draftClient.js";
import { PlanJobDispatcher } from "./job/dispatch.js";
import { ERROR_CODES, type Handler } from "./job/errors.js";
import { createMasterPlanJobHandler } from "./kernel/masterHandler.js";
import { toMasterPlanGraphShim } from "./kernel/masterKernel.js";
import { PlanJobQueue, RabbitConsumer, RabbitPublisher } from "./queue/rabbit.js";
import { MySqlPlanJobStore } from "./storage/planJobs.js";

const logger = getLogger("plan-job/main");

async function main(): Promise<void> {
  const workerConfig = loadWorkerConfig({ configFiles: workerConfigFiles(import.meta.url) });
  const coachConfig = loadConfig({ configFiles: coachAgentConfigFiles(import.meta.url) });

  await ensureDatabase(workerConfig.persistenceDatabase);
  const persistencePool = createPool(workerConfig.persistenceDatabase);
  const stridePool = createStridePool(workerConfig.strideDatabase);

  const queue = await PlanJobQueue.connect(workerConfig.amqpUrl);
  await queue.declareTopology(workerConfig.queues);
  const publisher = await RabbitPublisher.create(queue, workerConfig.queues);

  const store = new MySqlPlanJobStore(persistencePool);
  await store.setup();

  const dataProvider = new MySqlDataProvider(stridePool);
  const graph = toMasterPlanGraphShim(createMasterPlanGraph(await masterPlanDependencies(coachConfig, dataProvider)));

  const draftClient = new GoDraftClient(workerConfig.goApi.baseUrl, workerConfig.goApi.internalToken);
  const handlers = new Map<string, Handler>([
    [
      "generate_master_plan",
      createMasterPlanJobHandler({
        graph,
        // The draft's goal_id references the athlete's active race_goal row.
        resolveGoalId: async (userId) => (await dataProvider.getRaceTarget(userId))?.goal_id ?? null,
        insertDraft: (userId, draftId, content) => draftClient.insertMasterPlanDraft(userId, draftId, content),
      }),
    ],
  ]);

  const dispatcher = new PlanJobDispatcher(store, handlers, publisher, workerConfig.retry, {
    now: () => new Date(),
  });

  const reconcileTimer = setInterval(() => {
    const now = new Date();
    void store
      .failStaleRunning(new Date(now.getTime() - workerConfig.staleRunningMs), now, ERROR_CODES.HEARTBEAT_TIMEOUT)
      .then((failed) => {
        if (failed > 0) logger.warn({ failed }, "reconciled stale running plan-jobs to failed");
        logger.info({ queueHealthy: queue.isHealthy(), publisherHealthy: publisher.isHealthy() }, "plan-job worker heartbeat");
      })
      .catch((error: unknown) => logger.error({ error }, "plan-job reconcile/heartbeat failed"));
  }, workerConfig.reconcileIntervalMs);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "plan-job worker shutting down");
    clearInterval(reconcileTimer);
    await publisher.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await Promise.allSettled([persistencePool.end(), stridePool.end()]);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await RabbitConsumer.create(queue).run(workerConfig.queues, workerConfig.consumer.prefetch, (message) => dispatcher.dispatch(message));
  } finally {
    await shutdown("consumer-exit");
  }
}

async function masterPlanDependencies(
  coachConfig: ReturnType<typeof loadConfig>,
  dataProvider: MySqlDataProvider,
): Promise<Parameters<typeof createMasterPlanGraph>[0]> {
  const masterPlanModel = getAgentConfig(coachConfig, "master_plan");
  const reviewerModel = getAgentConfig(coachConfig, "reviewer");
  const llmModels = await createMasterPlanLlmModels({ masterPlanModel, reviewerModel });
  return { contextProvider: new DataProviderMasterPlanContextProvider(dataProvider), ...llmModels };
}

await main().catch((error: unknown) => {
  logger.error({ error }, "plan-job worker exited with error");
  process.exitCode = 1;
});
