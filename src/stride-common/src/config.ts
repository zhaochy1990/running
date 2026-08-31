/**
 * Shared STRIDE configuration loading for the Node packages, backed by
 * [convict](https://github.com/mozilla/node-convict).
 *
 * Both `coach_agent` and `coach_agent_api` delegate here so there is a single
 * config engine. Callers resolve the absolute config file paths themselves and
 * pass them in (`configFiles`); loaders do not do repo-root or relative-path
 * discovery. The active environment is taken only from `STRIDE_COACH_ENV` and
 * must be one of {@link SUPPORTED_ENVIRONMENTS}.
 */

import convict from "convict";
import { parse } from "yaml";

/** The only deployment environments STRIDE supports. Any other value is rejected. */
export const SUPPORTED_ENVIRONMENTS = ["local", "dev", "staging", "prod"] as const;
export type Environment = (typeof SUPPORTED_ENVIRONMENTS)[number];

export const DEFAULT_ENVIRONMENT: Environment = "local";

// Register the YAML parser for convict once (idempotent across packages).
convict.addParser({ extension: ["yaml", "yml"], parse });

export interface ResolveEnvironmentOptions {
  /** Environment to read STRIDE_COACH_ENV from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the active STRIDE environment from `STRIDE_COACH_ENV` only (default
 * `local`). Any value outside {@link SUPPORTED_ENVIRONMENTS} is rejected.
 */
export function resolveEnvironment(options: ResolveEnvironmentOptions = {}): Environment {
  const source = options.env ?? process.env;
  const value = source.STRIDE_COACH_ENV ?? DEFAULT_ENVIRONMENT;
  if (!(SUPPORTED_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new Error(`Unsupported environment "${value}". Supported values: ${SUPPORTED_ENVIRONMENTS.join(", ")}.`);
  }
  return value as Environment;
}

export interface LoadConfigOptions<T> {
  /** Convict schema describing the config shape. */
  schema: convict.Schema<T>;
  /** Absolute paths to YAML config files, loaded in order (later overrides earlier). */
  configFiles: string[];
  /** Environment used by convict for `${env}`-style overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Reject YAML keys not declared in the schema. Default `true` (fails closed). */
  strict?: boolean;
}

/**
 * Load YAML config files with convict: merge in order, apply environment-variable
 * overrides, validate against the schema, and return the resolved config.
 */
export function loadConfig<T>(options: LoadConfigOptions<T>): T {
  if (options.configFiles.length === 0) {
    throw new Error("At least one config file path is required");
  }
  const config = convict<T>(options.schema, { env: options.env ?? process.env, args: [] });
  config.loadFile(options.configFiles);
  config.validate({ allowed: options.strict === false ? "warn" : "strict" });

  return config.getProperties() as T;
}
