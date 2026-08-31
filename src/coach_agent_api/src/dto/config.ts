export interface RawApiConfig {
  api: {
    host: string;
    port: number;
  };
  auth: {
    public_key_pem: string;
    public_key_path: string;
    issuer: string;
    audience: string;
  };
  stride_database: MySqlConfig;
  persistence_database: MySqlConfig;
}

export interface ApiConfig {
  host: string;
  port: number;
  strideDatabase: MySqlConfig;
  persistenceDatabase: MySqlConfig;
  auth: { publicKeyPem: string; issuer: string; audience?: string | string[] };
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
