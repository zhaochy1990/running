import { getLogger, loadConfig as loadWithConvict } from "@stride/common";
import type { CoachAgentConfig, ModelConfig } from "./types.js";

const logger = getLogger("config");

export type * from "./types.js";

/**
 * Convict schema for the coach config. The model registry is dynamic, so the
 * array items are declared as opaque (validated only at the `Array` level) and
 * the loader runs leniently (`strict: false`) so unknown per-model metadata is
 * preserved rather than rejected.
 */
const coachSchema = {
  models: { format: Array, default: [] },
  agents: { format: Array, default: [] },
  observability: { default: {} },
};

export interface LoadConfigOptions {
  /** Absolute paths to the YAML config file(s), merged in order (later wins). */
  configFiles: string[];
}

export function loadConfig(options: LoadConfigOptions): CoachAgentConfig {
  logger.info({ configFiles: options.configFiles }, "Loading coach config");
  // The coach registry is dynamic; the convicted output is trusted to match the shape.
  return loadWithConvict({ schema: coachSchema, configFiles: options.configFiles, strict: false }) as unknown as CoachAgentConfig;
}

export function getAgentConfig(config: CoachAgentConfig, agentName: string): ModelConfig {
  const agentConfig = config.agents.find((agent) => agent.name === agentName);
  if (!agentConfig || typeof agentConfig !== "object" || !("model" in agentConfig)) {
    throw new Error(`Agent "${agentName}" is not defined in the coach config`);
  }

  const model = config.models.find((candidate) => candidate.name === agentConfig.model);
  if (!model) {
    throw new Error(`Model "${agentConfig.model}" is not defined in the coach config`);
  }

  // Return a copy so per-agent overrides never leak back into the shared model
  // entry (multiple roles may reference the same `models[].name`).
  const resolved: ModelConfig = { ...model };
  if (agentConfig.max_tokens !== undefined) {
    resolved.max_tokens = agentConfig.max_tokens;
  }
  if (agentConfig.timeout_s !== undefined) {
    resolved.timeout_s = agentConfig.timeout_s;
  }
  if (agentConfig.reasoning_effort !== undefined) {
    resolved.reasoning_effort = agentConfig.reasoning_effort;
  }
  if (agentConfig.thinking !== undefined) {
    resolved.thinking = agentConfig.thinking;
  }
  if (agentConfig.response_format !== undefined) {
    resolved.response_format = agentConfig.response_format;
  }
  if (agentConfig.api_kind !== undefined) {
    resolved.api_kind = agentConfig.api_kind;
  }

  return resolved;
}
