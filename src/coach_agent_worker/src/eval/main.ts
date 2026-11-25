import { createMasterPlanGraph, loadConfig, type MasterPlanContextProvider } from "@stride/coach-agent";
import { getLogger } from "@stride/common";
import { masterLlmModels } from "../app/dependencies.js";
import { coachAgentConfigFiles } from "../configPaths.js";
import { toMasterPlanGraphShim } from "../kernel/master/kernel.js";
import { PlanJobQueue } from "../queue/rabbit.js";
import { EvalApiClient } from "./client.js";
import { loadEvalWorkerConfig } from "./config.js";
import { EvalConsumer } from "./consumer.js";
import { EvalDispatcher } from "./dispatch.js";
import { generateArtifact } from "./generate.js";

const logger = getLogger("plan-eval/main");

/**
 * 测评启动模式（`PLAN_WORKER_MODE=eval`，devops#1047/#1055）：不连运动员库、不连 Go
 * internal API、不装配任何写工具——只连测评 MQ 与测评内部 API。生成内核、上下文装配和
 * LLM 模型都来自本镜像，所以被测的就是这个发布版本的真实代码；模型凭据由测评部署注入。
 */
export async function runEvalWorker(): Promise<void> {
  const config = loadEvalWorkerConfig();
  // The config paths are resolved relative to a module at dist/src/ depth (the
  // production entry's location), one level up from this file.
  const coachConfig = loadConfig({ configFiles: coachAgentConfigFiles(new URL("../main.js", import.meta.url).href) });

  const queue = await PlanJobQueue.connectWithRetry(config.amqpUrl);
  const dispatcher = new EvalDispatcher({
    client: new EvalApiClient(config.api.baseUrl, config.api.token),
    agentVersion: config.agentVersion,
    workerId: process.env.HOSTNAME ?? "plan-eval-worker",
    generate: (input) =>
      generateArtifact(
        input,
        {
          buildGraph: (contextProvider: MasterPlanContextProvider) =>
            toMasterPlanGraphShim(createMasterPlanGraph({ contextProvider, ...masterLlmModels(coachConfig) })),
        },
        async (stage, progressPct) => logger.info({ stage, progressPct }, "plan-eval generate progress"),
      ),
    lease: { renewIntervalMs: config.lease.renewIntervalMs, busyMaxWaitMs: config.leaseBusyMaxWaitMs },
  });
  logger.info({ queue: config.queue, agentVersion: config.agentVersion }, "plan-eval worker started");

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await queue.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  try {
    await EvalConsumer.create(queue, config.queue).run(config.consumer.prefetch, config.faultBackoffMs, (message) => dispatcher.process(message));
  } finally {
    await shutdown();
  }
}
