export interface RawApiConfig {
  api: {
    host: string;
    port: number;
  };
  auth: {
    public_key_pem: string;
    public_key_path: string;
    auth_service_url: string;
    issuer: string;
    audience: string;
    admin_audience: string;
  };
  stride_database: MySqlConfig;
  persistence_database: MySqlConfig;
  plan_jobs: { amqp_url: string; queues: { work: string; retry: string; poison: string } };
  go_api: { base_url: string; internal_token: string };
}

export interface ApiConfig {
  host: string;
  port: number;
  strideDatabase: MySqlConfig;
  persistenceDatabase: MySqlConfig;
  planJobs: { amqpUrl: string; queues: { work: string; retry: string; poison: string } };
  /** Go API internal endpoints (X-Internal-Token): plan-job create/poll (ADR 0033). */
  goApi: { baseUrl: string; internalToken: string };
  auth: { publicKeyPem: string; authServiceUrl: string; issuer: string; audience?: string | string[]; adminAudience?: string };
}

export interface LoadApiConfigOptions {
  /** Absolute paths to the YAML config file(s), loaded in order (later wins). */
  configFiles: string[];
  /** Environment used by convict for env-var overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
