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
  auth: { publicKeyPem: string; issuer: string; audience?: string };
}

export interface LoadApiConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MySqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
