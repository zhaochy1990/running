import convict from "convict";

/**
 * 显式启动模式（devops#1047/#1055）：缺省 `prod`；`eval` 在任何生产依赖（运动员库、
 * Go internal API）初始化之前分流到测评入口。未知模式直接报错退出。
 */
export type WorkerMode = "prod" | "eval";

export function resolveWorkerMode(env: NodeJS.ProcessEnv = process.env): WorkerMode {
  const raw = env.PLAN_WORKER_MODE ?? "prod";
  if (raw === "prod" || raw === "eval") return raw;
  throw new Error(`Unsupported PLAN_WORKER_MODE "${raw}". Supported values: prod, eval.`);
}

/** 测评容器的全部运行依赖：测评 MQ、本版本队列、测评内部 API。 */
export interface EvalWorkerConfig {
  amqpUrl: string;
  /** 本 Agent 版本的执行队列（一个版本一条，由测评部署注入）。 */
  queue: string;
  /** 镜像的发布标签；领取时上送，测评 API 据此校验版本。 */
  agentVersion: string;
  api: { baseUrl: string; token: string };
  consumer: { prefetch: number };
  /** 租约续租间隔；应明显短于测评 API 的租约期限。 */
  lease: { renewIntervalMs: number };
  /** 别的 worker 持有有效租约时，保持消息未确认并退避重试的最长等待。 */
  leaseBusyMaxWaitMs: number;
  /** 测评 API 故障等基础设施错误：退避后再交还 broker 重投。 */
  faultBackoffMs: number;
}

interface RawEvalConfig {
  eval: {
    amqp_url: string;
    queue: string;
    agent_version: string;
    api_base_url: string;
    api_token: string;
    prefetch: number;
    lease_renew_interval_ms: number;
    lease_busy_max_wait_ms: number;
    fault_backoff_ms: number;
  };
}

const requiredString = (value: unknown): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("must be a non-empty string");
  }
};
const positiveInt = (value: unknown): void => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("must be a positive integer");
  }
};

const schema: convict.Schema<RawEvalConfig> = {
  eval: {
    // 与生产模式同一个 env：测评部署注入的是测评 MQ 的地址。
    amqp_url: { format: requiredString, default: "", env: "PLAN_WORKER_AMQP_URL", sensitive: true },
    queue: { format: requiredString, default: "", env: "PLAN_WORKER_EVAL_QUEUE" },
    agent_version: { format: requiredString, default: "", env: "PLAN_WORKER_EVAL_AGENT_VERSION" },
    api_base_url: { format: requiredString, default: "", env: "PLAN_WORKER_EVAL_API_BASE_URL" },
    api_token: { format: requiredString, default: "", env: "PLAN_WORKER_EVAL_API_TOKEN", sensitive: true },
    prefetch: { format: positiveInt, default: 1, env: "PLAN_WORKER_CONSUMER_PREFETCH" },
    lease_renew_interval_ms: { format: positiveInt, default: 20_000, env: "PLAN_WORKER_EVAL_LEASE_RENEW_INTERVAL_MS" },
    lease_busy_max_wait_ms: { format: positiveInt, default: 120_000, env: "PLAN_WORKER_EVAL_LEASE_BUSY_MAX_WAIT_MS" },
    fault_backoff_ms: { format: positiveInt, default: 5_000, env: "PLAN_WORKER_EVAL_FAULT_BACKOFF_MS" },
  },
};

/** 测评模式没有 YAML 文件——全部来自环境变量，缺任何一项都在启动时报错。 */
export function loadEvalWorkerConfig(env: NodeJS.ProcessEnv = process.env): EvalWorkerConfig {
  const raw = convict(schema, { env, args: [] });
  raw.validate({ allowed: "strict" });
  const { eval: e } = raw.getProperties();
  return {
    amqpUrl: e.amqp_url,
    queue: e.queue,
    agentVersion: e.agent_version,
    api: { baseUrl: e.api_base_url, token: e.api_token },
    consumer: { prefetch: e.prefetch },
    lease: { renewIntervalMs: e.lease_renew_interval_ms },
    leaseBusyMaxWaitMs: e.lease_busy_max_wait_ms,
    faultBackoffMs: e.fault_backoff_ms,
  };
}
