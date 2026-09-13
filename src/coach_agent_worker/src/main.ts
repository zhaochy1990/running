import { loadConfig } from "@stride/coach-agent";
import { getLogger } from "@stride/common";
import { masterPlanGraph, weeklyPlanGraph } from "./app/dependencies.js";
import { createPlanJobHandlers } from "./app/handlers.js";
import { startReconcileTimer } from "./app/reconcile.js";
import { loadWorkerConfig } from "./config.js";
import { coachAgentConfigFiles, workerConfigFiles } from "./configPaths.js";
import { MySqlDataProvider } from "./data/mysqlDataProvider.js";
import { createPool, createStridePool, ensureDatabase } from "./db/mysql.js";
import { GoDraftClient } from "./goClient/draftClient.js";
import { PlanJobDispatcher } from "./job/dispatch.js";
import { PlanJobQueue, RabbitConsumer, RabbitPublisher } from "./queue/rabbit.js";
import { MySqlPlanJobStore } from "./storage/planJobs.js";

const logger = getLogger("plan-job/main");

/**
 * Thin entry point: load config → boot infrastructure → wire per-job-type
 * handlers (see `app/`) → run the consumer → shutdown on signal. All business
 * logic lives in `kernel/`, `app/`, and the domain modules.
 */
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
  const draftClient = new GoDraftClient(workerConfig.goApi.baseUrl, workerConfig.goApi.internalToken);
  const handlers = createPlanJobHandlers({
    masterGraph: await masterPlanGraph(coachConfig, dataProvider),
    weeklyGraph: weeklyPlanGraph(coachConfig, dataProvider),
    dataProvider,
    draftClient,
  });

  const dispatcher = new PlanJobDispatcher(store, handlers, publisher, workerConfig.retry, {
    now: () => new Date(),
  });

  const reconcileTimer = startReconcileTimer({
    store,
    queue,
    publisher,
    staleRunningMs: workerConfig.staleRunningMs,
    reconcileIntervalMs: workerConfig.reconcileIntervalMs,
  });

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

await main().catch((error: unknown) => {
  logger.error({ error }, "plan-job worker exited with error");
  process.exitCode = 1;
});
