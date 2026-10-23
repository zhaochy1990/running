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
  /** Coach chat sharing (#715). wxacode is optional: empty base_url disables it (fail-soft by design). */
  share: {
    wxacode_base_url: string;
    wxacode_internal_token: string;
    wxacode_page: string;
    wxacode_env_version: "trial" | "develop" | "release";
  };
  logging: { file: string };
}

export interface ApiConfig {
  host: string;
  port: number;
  strideDatabase: MySqlConfig;
  persistenceDatabase: MySqlConfig;
  planJobs: { amqpUrl: string; queues: { work: string; retry: string; poison: string } };
  /** Go API internal endpoints (X-Internal-Token): plan-job create/poll (ADR 0033). */
  goApi: { baseUrl: string; internalToken: string };
  /** Coach chat sharing (#715); wxacodeBaseUrl empty = wxacode generation disabled. */
  share: {
    wxacodeBaseUrl: string;
    wxacodeInternalToken: string;
    wxacodePage: string;
    wxacodeEnvVersion: "trial" | "develop" | "release";
  };
  auth: { publicKeyPem: string; authServiceUrl: string; issuer: string; audience?: string | string[]; adminAudience?: string };
  /** Local-only debug log file (absolute); empty = log to stdout only. */
  logFile: string;
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
