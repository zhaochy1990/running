import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { loadConfig } from "@stride/common";
import convict from "convict";
import type { ApiConfig, LoadApiConfigOptions, MySqlConfig, RawApiConfig } from "./dto/config.js";

convict.addFormat({
  name: "active-port",
  coerce: (value) => Number(value),
  validate: (value) => {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error("must be an integer between 1 and 65535");
    }
  },
});

const requiredString = (value: unknown): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("must be a non-empty string");
  }
};

const databaseName = (value: unknown): void => {
  requiredString(value);
  if (!/^[A-Za-z0-9_]+$/.test(value as string)) {
    throw new Error("must be a plain MySQL identifier");
  }
};

const schema: convict.Schema<RawApiConfig> = {
  api: {
    host: {
      doc: "HTTP bind address",
      format: requiredString,
      default: "0.0.0.0",
      env: "STRIDE_COACH_API_HOST",
    },
    port: {
      doc: "HTTP listen port",
      format: "active-port",
      default: 8080,
      env: "STRIDE_COACH_API_PORT",
    },
  },
  auth: {
    public_key_pem: {
      doc: "Inline RS256 public key PEM",
      format: String,
      default: "",
      env: "STRIDE_AUTH_PUBLIC_KEY_PEM",
      sensitive: true,
    },
    public_key_path: {
      doc: "RS256 public key path, relative to the config file's directory",
      format: String,
      default: "",
      env: "STRIDE_AUTH_PUBLIC_KEY_PATH",
    },
    auth_service_url: {
      doc: "Auth service origin; the RS256 public key is fetched from <url>/api/system/public-key at startup",
      format: String,
      default: "",
      env: "STRIDE_AUTH_SERVICE_URL",
    },
    issuer: {
      doc: "Expected JWT issuer",
      format: requiredString,
      default: "auth-service",
      env: "STRIDE_AUTH_ISSUER",
    },
    audience: {
      doc: "Optional expected JWT audience",
      format: String,
      default: "",
      env: "STRIDE_AUTH_AUDIENCE",
    },
  },
  stride_database: databaseSchema({
    host: "STRIDE_COACH_DATA_HOST",
    port: "STRIDE_COACH_DATA_PORT",
    user: "STRIDE_COACH_DATA_READONLY_USER",
    password: "STRIDE_COACH_DATA_READONLY_PASSWORD",
    database: "STRIDE_COACH_DATA_DATABASE",
  }),
  persistence_database: databaseSchema({
    host: "COACH_AGENT_MYSQL_HOST",
    port: "COACH_AGENT_MYSQL_PORT",
    user: "COACH_AGENT_MYSQL_USER",
    password: "COACH_AGENT_MYSQL_PASSWORD",
    database: "COACH_AGENT_MYSQL_DATABASE",
  }),
};

export function loadApiConfig(options: LoadApiConfigOptions): ApiConfig {
  const rawEnv = normalizeAuthEnvironment(options.env ?? process.env);
  const raw = loadConfig({ schema, configFiles: options.configFiles, env: rawEnv, strict: true });
  const configDir = dirname(options.configFiles[0] ?? "");
  const publicKeyPem = resolvePublicKey(raw.auth, configDir);

  return {
    host: raw.api.host,
    port: raw.api.port,
    strideDatabase: raw.stride_database,
    persistenceDatabase: raw.persistence_database,
    auth: {
      publicKeyPem,
      authServiceUrl: raw.auth.auth_service_url,
      issuer: raw.auth.issuer,
      ...(raw.auth.audience ? { audience: raw.auth.audience } : {}),
    },
  };
}

function databaseSchema(env: { host: string; port: string; user: string; password: string; database: string }): convict.Schema<MySqlConfig> {
  return {
    host: { format: requiredString, default: "", env: env.host },
    port: { format: "active-port", default: 3306, env: env.port },
    user: { format: requiredString, default: "", env: env.user },
    password: {
      format: requiredString,
      default: "",
      env: env.password,
      sensitive: true,
    },
    database: { format: databaseName, default: "", env: env.database },
  };
}

/** An environment-supplied key source replaces the key source from YAML. */
function normalizeAuthEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized = { ...env };
  const hasPem = Boolean(env.STRIDE_AUTH_PUBLIC_KEY_PEM);
  const hasPath = Boolean(env.STRIDE_AUTH_PUBLIC_KEY_PATH);
  const hasUrl = Boolean(env.STRIDE_AUTH_SERVICE_URL);

  if ([hasPem, hasPath, hasUrl].filter(Boolean).length > 1) {
    throw new Error("Set only one of STRIDE_AUTH_PUBLIC_KEY_PEM, STRIDE_AUTH_PUBLIC_KEY_PATH, or STRIDE_AUTH_SERVICE_URL");
  }
  if (hasPem) {
    normalized.STRIDE_AUTH_PUBLIC_KEY_PATH = "";
    normalized.STRIDE_AUTH_SERVICE_URL = "";
  }
  if (hasPath) {
    normalized.STRIDE_AUTH_PUBLIC_KEY_PEM = "";
    normalized.STRIDE_AUTH_SERVICE_URL = "";
  }
  if (hasUrl) {
    normalized.STRIDE_AUTH_PUBLIC_KEY_PEM = "";
    normalized.STRIDE_AUTH_PUBLIC_KEY_PATH = "";
  }
  return normalized;
}

function resolvePublicKey(auth: RawApiConfig["auth"], configDir: string): string {
  const sources = [auth.public_key_pem, auth.public_key_path, auth.auth_service_url].filter(Boolean);
  if (sources.length > 1) {
    throw new Error("Configure only one of auth.public_key_pem, auth.public_key_path, or auth.auth_service_url");
  }

  if (auth.public_key_pem) {
    return auth.public_key_pem;
  }

  if (auth.public_key_path) {
    const keyPath = isAbsolute(auth.public_key_path) ? auth.public_key_path : resolve(configDir, auth.public_key_path);
    return readFileSync(keyPath, "utf8");
  }

  // No static key: fetch from the auth-service at startup (runtime.ts).
  if (auth.auth_service_url) {
    return "";
  }

  throw new Error("auth.public_key_pem, auth.public_key_path, or auth.auth_service_url must be configured");
}
