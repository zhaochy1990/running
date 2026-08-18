import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { deepMerge } from "./deepMerge.js";
import type {
	CoachAgentConfig,
	PartialCoachAgentConfig,
	ModelConfig,
	DataStoreConfig,
} from "./types.js";
import { getLogger } from "../utils/logger.js";

export type * from "./types.js";

// default env is "local" if STRIDE_COACH_ENV and NODE_ENV are not set
const ENV = process.env.STRIDE_COACH_ENV ?? process.env.NODE_ENV ?? "local";
const DEFAULT_CONFIG_FILE = "coach.yaml";
const TARGET_ENV_CONFIG_FILE = `coach.${ENV}.yaml`;
const logger = getLogger("config");

interface ResolvedConfigFiles {
	defaultConfigFile?: string;
	targetEnvConfigFile?: string;
}

export interface LoadConfigOptions {
	cwd?: string;
	/** Explicit config file path; when provided it is merged on top of the default config (like the env-specific file). */
	configFile?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): CoachAgentConfig {
	const configFiles = resolveConfigFiles(options);
	const defaultConfig = configFiles.defaultConfigFile ? readConfigFile(configFiles.defaultConfigFile) : {};
	const targetEnvConfigFile = options.configFile ?? configFiles.targetEnvConfigFile;
	const targetEnvConfig = targetEnvConfigFile ? readConfigFile(targetEnvConfigFile) : {};

	logger.info(`Loading coach config for env "${ENV}"`);
	logger.info(`  default config: ${configFiles.defaultConfigFile ?? "(none)"}`);
	logger.info(`  target env config: ${targetEnvConfigFile ?? "(none)"}${options.configFile ? " (explicit)" : ""}`);

	return deepMerge(defaultConfig, targetEnvConfig) as CoachAgentConfig;
}

export function getAgentConfig(
	config: CoachAgentConfig,
	agentName: string,
): ModelConfig {
	const agentConfig = config.agents.find((agent) => agent.name === agentName);
	if (
		!agentConfig ||
		typeof agentConfig !== "object" ||
		!("model" in agentConfig)
	) {
		throw new Error(`Agent "${agentName}" is not defined in the coach config`);
	}

	const model = config.models.find(
		(candidate) => candidate.name === agentConfig.model,
	);
	if (!model) {
		throw new Error(
			`Model "${agentConfig.model}" is not defined in the coach config`,
		);
	}

	// override the model's base settings with any per-agent overrides
	if (agentConfig.max_tokens !== undefined) {
		model.max_tokens = agentConfig.max_tokens;
	}
	if (agentConfig.timeout_s !== undefined) {
		model.timeout_s = agentConfig.timeout_s;
	}
	if (agentConfig.reasoning_effort !== undefined) {
		model.reasoning_effort = agentConfig.reasoning_effort;
	}
	if (agentConfig.thinking !== undefined) {
		model.thinking = agentConfig.thinking;
	}
	if (agentConfig.response_format !== undefined) {
		model.response_format = agentConfig.response_format;
	}

	return model;
}

/**
 * Resolve the local `stride` MySQL connection settings from the `data_store`
 * block of the coach config. Parallels {@link getAgentConfig}: a pure read of
 * the already-loaded config that throws if the section is missing.
 */
export function readStrideMySqlConfig(
	config: CoachAgentConfig,
): DataStoreConfig {
	if (!config.data_store) {
		throw new Error("`data_store` is not defined in the coach config");
	}
	return config.data_store;
}

// Resolve the path to the config file based on the provided options and environment variables.
function resolveConfigFiles(
	options: LoadConfigOptions = {},
): ResolvedConfigFiles {
	const repoRoot = findRepoRoot(options.cwd ?? process.cwd());
	const configDir = join(repoRoot, "config");

	const defaultConfigPath = join(configDir, DEFAULT_CONFIG_FILE);
	const targetEnvConfigPath = join(configDir, TARGET_ENV_CONFIG_FILE);
	const configFiles: ResolvedConfigFiles = {};

	if (existsSync(defaultConfigPath)) {
		configFiles.defaultConfigFile = defaultConfigPath;
	}

	if (existsSync(targetEnvConfigPath)) {
		configFiles.targetEnvConfigFile = targetEnvConfigPath;
	}

	if (!configFiles.defaultConfigFile && !configFiles.targetEnvConfigFile) {
		throw new Error(
			`No config file found. Tried ${defaultConfigPath} and ${targetEnvConfigPath}`,
		);
	}

	return configFiles;
}

function readConfigFile(configPath: string): PartialCoachAgentConfig {
	const rawConfig = readFileSync(configPath, "utf8");
	const parsedConfig: unknown = parse(rawConfig);

	if (!isRecord(parsedConfig)) {
		throw new Error(`Config file must contain a YAML mapping: ${configPath}`);
	}

	return parsedConfig as PartialCoachAgentConfig;
}

function findRepoRoot(startDir: string = process.cwd()): string {
	let currentDir = resolve(startDir);
	const moduleDir = dirname(fileURLToPath(import.meta.url));

	for (const candidate of [currentDir, moduleDir]) {
		const found = findRepoRootFrom(candidate);
		if (found) {
			return found;
		}
	}

	throw new Error(`Unable to find repository root from ${currentDir}`);
}

function findRepoRootFrom(startDir: string): string | undefined {
	let currentDir = resolve(startDir);

	while (true) {
		if (
			existsSync(join(currentDir, "config")) &&
			existsSync(join(currentDir, ".root"))
		) {
			return currentDir;
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return undefined;
		}

		currentDir = parentDir;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
