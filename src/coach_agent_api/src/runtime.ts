import type { CoachAgentConfig } from "@stride/coach-agent";
import {
  createStridePool,
  GoJobClient,
  MySqlDataProvider,
  PLAN_JOB_ESTIMATED_DURATIONS_SECONDS,
  PlanJobEnqueuer,
  PlanJobQueue,
  type PlanJobType,
  RabbitPublisher,
} from "@stride/coach-agent-worker";
import { createApp } from "./app.js";
import { createJwtVerifier, fetchAuthPublicKey } from "./auth.js";
import { createActivityFeelWriter } from "./coach/activityFeelWriter.js";
import { CoachInvokerImpl } from "./coach/coachInvoker.js";
import { createAuthOpenidResolver } from "./coach/lotteryOpenid.js";
import { createLotterySyncTrigger } from "./coach/lotterySyncTrigger.js";
import type { ApiConfig } from "./dto/config.js";
import { MySqlCoachDataDeleter } from "./persistence/deletion.js";
import { createPersistence, type Persistence } from "./persistence/index.js";
import { MySqlWatchCredentialReader } from "./persistence/watchCredentials.js";
import type { PlanJobsService } from "./routes/planJobs.js";
import { AuthWxacodeClient } from "./routes/shares.js";

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
  // 抽奖绑表硬校验（#865）直读 stride 库 provider_credentials（只读），
  // 与 dataProvider 同一配置源；独立小池，关闭时一并释放。
  const watchPool = createStridePool(apiConfig.strideDatabase);
  let persistence: Persistence | undefined;
  // connectWithRetry (#726): a pod (re)built during a rabbitmq Recreate gap
  // must wait out the broker instead of exiting into CrashLoopBackOff — this
  // is the user-facing coach API, unavailable means coach chat is down.
  const planJobQueue = await PlanJobQueue.connectWithRetry(apiConfig.planJobs.amqpUrl);
  let planJobPublisher: RabbitPublisher | undefined;
  try {
    persistence = await createPersistence(apiConfig.persistenceDatabase);
    // #585：master-plan 生成不落库，卡片带 content+apply_token 由用户「应用」
    // 时落库——coach 侧计划写依赖清零。
    // #508：qa agent 的 set_activity_feel 走 Go API 写归一化 feel（fail-loud）。
    const coachInvoker = new CoachInvokerImpl(dataProvider, coachConfig, persistence, createActivityFeelWriter(apiConfig.goApi));
    await coachInvoker.initialize();

    // Deterministic plan-job enqueue (ADR 0030): store-first via the worker's
    // domain engine. The store is the Go job API (ADR 0033) — Go owns the `jobs`
    // row, so the coach API persists state through it and owns only the broker
    // pointer, exactly as Go's own StoreEnqueuer does for its queues.
    await planJobQueue.declareTopology(apiConfig.planJobs.queues);
    planJobPublisher = await RabbitPublisher.create(planJobQueue, apiConfig.planJobs.queues);
    const planJobStore = new GoJobClient(apiConfig.goApi.baseUrl, apiConfig.goApi.internalToken);
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
      // The row is Go's, so the ownership check is ours: a job id alone must not
      // let one athlete read another's job through this route.
      get: async (userId, jobId) => {
        const job = await planJobStore.get(jobId);
        return job !== null && job.userId === userId ? job : null;
      },
    };

    const jwtVerifier = createJwtVerifier({
      publicKeyPem: await resolvePublicKeyPem(apiConfig.auth),
      issuer: apiConfig.auth.issuer,
      ...(apiConfig.auth.audience ? { audience: apiConfig.auth.audience } : {}),
      ...(apiConfig.auth.adminAudience ? { adminAudience: apiConfig.auth.adminAudience } : {}),
    });
    return {
      app: createApp({
        jwtVerifier,
        turnCoordinator: persistence.turnCoordinator,
        coachInvoker: coachInvoker,
        checkpointer: persistence.checkpointer,
        // #891 聊天内绑赛：续轮从线程持久层回填 race target。
        threadRaceTargets: persistence.threadRaceTargets,
        planJobs,
        coachDataDeleter: new MySqlCoachDataDeleter(persistence.pool),
        // #863 抽奖活动配置域：admin CRUD + 落地页公开读取。
        lottery: persistence.lottery,
        // #865 抽奖核心：draw / my-result（绑表硬校验 + fail-soft 全量同步触发）。
        lotteryDraw: {
          store: persistence.lottery,
          watch: new MySqlWatchCredentialReader(watchPool),
          sync: createLotterySyncTrigger(apiConfig.goApi),
        },
        // #866 核销域：staff openid resolver 未配置（endpoint 为空）时不挂——
        // 端点整体 503，auth-service 内部端点上线后配置即生效。
        lotteryVerify: {
          store: persistence.lottery,
          ...(apiConfig.lottery.staffOpenidEndpoint !== "" && apiConfig.lottery.staffOpenidInternalToken !== ""
            ? {
                openid: createAuthOpenidResolver({
                  endpoint: apiConfig.lottery.staffOpenidEndpoint,
                  internalToken: apiConfig.lottery.staffOpenidInternalToken,
                }),
              }
            : {}),
        },
        // #867 staff 白名单管理 + 数据看板（漏斗读 + 公开埋点 ping）。
        lotteryStaff: persistence.lotteryStaff,
        lotteryFunnel: persistence.lotteryFunnel,
        // #715 分享服务：wxacode 未配置（base_url 为空）时不挂客户端——创建
        // 端 fail-soft 落 wxacode_url NULL，P1 auth 端点上线后配置即生效。
        coachShares: {
          store: persistence.shares,
          ...(apiConfig.share.wxacodeBaseUrl !== "" && apiConfig.share.wxacodeInternalToken !== ""
            ? {
                wxacode: new AuthWxacodeClient({
                  baseUrl: apiConfig.share.wxacodeBaseUrl,
                  internalToken: apiConfig.share.wxacodeInternalToken,
                  page: apiConfig.share.wxacodePage,
                  envVersion: apiConfig.share.wxacodeEnvVersion,
                }),
              }
            : {}),
        },
      }),
      close: () =>
        Promise.all([dataProvider.close(), watchPool.end(), persistence?.close(), planJobPublisher?.close(), planJobQueue.close()]).then(() => undefined),
    };
  } catch (error) {
    await Promise.allSettled([
      dataProvider.close(),
      watchPool.end(),
      ...(persistence ? [persistence.close()] : []),
      planJobPublisher?.close(),
      planJobQueue.close(),
    ]);
    throw error;
  }
}
