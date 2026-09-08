import type { CoachAgentConfig } from "@stride/coach-agent";
import {
  MySqlDataProvider,
  MySqlPlanJobStore,
  PLAN_JOB_ESTIMATED_DURATIONS_SECONDS,
  PlanJobEnqueuer,
  PlanJobQueue,
  type PlanJobType,
  RabbitPublisher,
} from "@stride/coach-agent-worker";
import { createApp } from "./app.js";
import { createJwtVerifier, fetchAuthPublicKey } from "./auth.js";
import { CoachInvokerImpl } from "./coach/coachInvoker.js";
import type { ApiConfig } from "./dto/config.js";
import { createPersistence, type Persistence } from "./persistence/index.js";
import type { PlanJobsService } from "./routes/planJobs.js";

export interface CoachApiRuntime {
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

/** Use the configured inline/file key, otherwise fetch it from the auth-service at startup. */
async function resolvePublicKeyPem(auth: ApiConfig["auth"]): Promise<string> {
  if (auth.publicKeyPem) {
    return auth.publicKeyPem;
  }
  if (!auth.authServiceUrl) {
    throw new Error("auth.public_key_pem, auth.public_key_path, or auth.auth_service_url must be configured");
  }
  return fetchAuthPublicKey(auth.authServiceUrl);
}

/** Compose API-owned adapters and release partial resources if startup fails. */
export async function createCoachApiRuntime(apiConfig: ApiConfig, coachConfig: CoachAgentConfig): Promise<CoachApiRuntime> {
  const dataProvider = MySqlDataProvider.create(apiConfig.strideDatabase);
  let persistence: Persistence | undefined;
  const planJobQueue = await PlanJobQueue.connect(apiConfig.planJobs.amqpUrl);
  let planJobPublisher: RabbitPublisher | undefined;
  try {
    persistence = await createPersistence(apiConfig.persistenceDatabase);
    const coachInvoker = new CoachInvokerImpl(dataProvider, coachConfig, persistence);
    await coachInvoker.initialize();

    // Deterministic plan-job enqueue (ADR 0030): store-first via the worker's
    // domain engine, so the chat service and the worker share one implementation.
    await planJobQueue.declareTopology(apiConfig.planJobs.queues);
    planJobPublisher = await RabbitPublisher.create(planJobQueue, apiConfig.planJobs.queues);
    const planJobStore = new MySqlPlanJobStore(persistence.pool);
    await planJobStore.setup();
    const enqueuer = new PlanJobEnqueuer(planJobStore, planJobPublisher);
    const planJobs: PlanJobsService = {
      enqueue: ({ userId, jobType, inputJson, idempotencyKey }) =>
        enqueuer.enqueue(
          {
            jobType,
            userId,
            inputJson,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          },
          PLAN_JOB_ESTIMATED_DURATIONS_SECONDS[jobType as PlanJobType],
        ),
      get: async (userId, jobId) => {
        const job = await planJobStore.get(jobId);
        return job !== null && job.userId === userId ? job : null;
      },
    };

    const jwtVerifier = createJwtVerifier({
      publicKeyPem: await resolvePublicKeyPem(apiConfig.auth),
      issuer: apiConfig.auth.issuer,
      ...(apiConfig.auth.audience ? { audience: apiConfig.auth.audience } : {}),
    });
    return {
      app: createApp({
        jwtVerifier,
        turnCoordinator: persistence.turnCoordinator,
        coachInvoker: coachInvoker,
        checkpointer: persistence.checkpointer,
        planJobs,
      }),
      close: () => Promise.all([dataProvider.close(), persistence?.close(), planJobPublisher?.close(), planJobQueue.close()]).then(() => undefined),
    };
  } catch (error) {
    await Promise.allSettled([dataProvider.close(), ...(persistence ? [persistence.close()] : []), planJobPublisher?.close(), planJobQueue.close()]);
    throw error;
  }
}
