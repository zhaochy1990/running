import { loadConfig } from "@stride/common";
import convict from "convict";

export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface WorkerConfig {
  amqpUrl: string;
  queues: { work: string; retry: string; poison: string };
  retry: { maxAttempts: number; baseBackoffMs: number; maxBackoffMs: number };
  consumer: { prefetch: number };
  /** A running job with no heartbeat for this long may be reclaimed / reconciled. */
  staleRunningMs: number;
  /** How often the stale-running reconcile + heartbeat log run. */
  reconcileIntervalMs: number;
  /** A live run this young is "fresh" (owner alive) at redelivery. */
  strideDatabase: MySqlConfig;
  /** Coach persistence DB — home of the plan_jobs table. */
  persistenceDatabase: MySqlConfig;
  /** Go API internal insert endpoint (X-Internal-Token). */
  goApi: { baseUrl: string; internalToken: string };
}

interface RawWorkerConfig {
  worker: {
    amqp_url: string;
    queues: { work: string; retry: string; poison: string };
    retry: { max_attempts: number; base_backoff_ms: number; max_backoff_ms: number };
    consumer: { prefetch: number };
    stale_running_ms: number;
    reconcile_interval_ms: number;
  };
  stride_database: MySqlConfig;
  persistence_database: MySqlConfig;
  go_api: { base_url: string; internal_token: string };
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

const databaseSchema = (prefix: string): convict.Schema<MySqlConfig> => ({
  host: { format: requiredString, default: "", env: `${prefix}_HOST` },
  port: { format: "active-port", default: 3306, env: `${prefix}_PORT` },
  user: { format: requiredString, default: "", env: `${prefix}_USER` },
  password: { format: requiredString, default: "", env: `${prefix}_PASSWORD`, sensitive: true },
  database: { format: requiredString, default: "", env: `${prefix}_DATABASE` },
});

convict.addFormat({
  name: "active-port",
  coerce: (value) => Number(value),
  validate: (value) => {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error("must be an integer between 1 and 65535");
    }
  },
});

const schema: convict.Schema<RawWorkerConfig> = {
  worker: {
    amqp_url: { format: requiredString, default: "amqp://guest:guest@127.0.0.1:5672/", env: "PLAN_WORKER_AMQP_URL", sensitive: true },
    queues: {
      work: { format: String, default: "plan.jobs", env: "PLAN_WORKER_QUEUES_WORK" },
      retry: { format: String, default: "plan.jobs.retry", env: "PLAN_WORKER_QUEUES_RETRY" },
      poison: { format: String, default: "plan.jobs.poison", env: "PLAN_WORKER_QUEUES_POISON" },
    },
    retry: {
      max_attempts: { format: positiveInt, default: 2, env: "PLAN_WORKER_RETRY_MAX_ATTEMPTS" },
      base_backoff_ms: { format: positiveInt, default: 10_000, env: "PLAN_WORKER_RETRY_BASE_BACKOFF_MS" },
      max_backoff_ms: { format: positiveInt, default: 60_000, env: "PLAN_WORKER_RETRY_MAX_BACKOFF_MS" },
    },
    consumer: { prefetch: { format: positiveInt, default: 1, env: "PLAN_WORKER_CONSUMER_PREFETCH" } },
    // Longer than the kernel's longest single-node LLM bound (600s model
    // timeout), so a slow node is never falsely killed as stale.
    stale_running_ms: { format: positiveInt, default: 900_000, env: "PLAN_WORKER_STALE_RUNNING_MS" },
    reconcile_interval_ms: { format: positiveInt, default: 30_000, env: "PLAN_WORKER_RECONCILE_INTERVAL_MS" },
  },
  stride_database: databaseSchema("PLAN_WORKER_STRIDE_DATABASE"),
  persistence_database: databaseSchema("PLAN_WORKER_PERSISTENCE_DATABASE"),
  go_api: {
    base_url: { format: requiredString, default: "http://127.0.0.1:8080", env: "PLAN_WORKER_GO_API_BASE_URL" },
    internal_token: { format: requiredString, default: "", env: "PLAN_WORKER_GO_API_INTERNAL_TOKEN", sensitive: true },
  },
};

export function loadWorkerConfig(options: { configFiles: string[]; env?: NodeJS.ProcessEnv }): WorkerConfig {
  const raw = loadConfig({ schema, configFiles: options.configFiles, env: options.env ?? process.env, strict: true });
  return {
    amqpUrl: raw.worker.amqp_url,
    queues: raw.worker.queues,
    retry: {
      maxAttempts: raw.worker.retry.max_attempts,
      baseBackoffMs: raw.worker.retry.base_backoff_ms,
      maxBackoffMs: raw.worker.retry.max_backoff_ms,
    },
    consumer: raw.worker.consumer,
    staleRunningMs: raw.worker.stale_running_ms,
    reconcileIntervalMs: raw.worker.reconcile_interval_ms,
    strideDatabase: raw.stride_database,
    persistenceDatabase: raw.persistence_database,
    goApi: { baseUrl: raw.go_api.base_url, internalToken: raw.go_api.internal_token },
  };
}
