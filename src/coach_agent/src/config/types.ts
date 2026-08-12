import type { MySqlConfig } from "../persistence/mysql.js";

/**
 * Connection settings for the local `stride` MySQL DB (watch-sync data read by
 * StrideDataStore). Same shape as the persistence-layer `MySqlConfig` — reused
 * here as the single source of truth so the two can't drift. Loaded from the
 * `data_store` block of the coach config via `readStrideMySqlConfig`.
 */
export type DataStoreConfig = MySqlConfig;

export type ModelProvider = "openai-compatible" | "azure-openai";
export type ModelAuth = "api-key" | "managed-identity";
export type ModelApiKind = "chat-completions" | "responses";
export type ReasoningEffort = "high" | "max";

export interface ModelConfig {
	name: string;
	provider: ModelProvider;
	model: string;
	deployment: string;
	endpoint: string;
	api_key_env?: string;
	api_version?: string;
	auth: ModelAuth;
	api_kind: ModelApiKind;
	temperature?: number;
	max_tokens: number;
	timeout_s: number;
	reasoning_effort?: ReasoningEffort;
	thinking?: "enabled";
	response_format?: "json_object";
}

export interface RoleConfig {
	name: string;
	model: string;
	max_tokens?: number;
	timeout_s?: number;
	reasoning_effort?: ReasoningEffort;
	thinking?: "enabled";
	response_format?: "json_object";
}

export interface ObservabilityConfig {
	langsmith_enabled: boolean;
	langsmith_project: string;
	langsmith_endpoint: string;
	langsmith_api_key_env: string;
}

export interface CoachAgentConfig {
	models: ModelConfig[];
	agents: RoleConfig[];
	observability: ObservabilityConfig;
	data_store?: DataStoreConfig;
}

export type PartialCoachAgentConfig = DeepPartial<CoachAgentConfig>;

export type DeepPartial<T> = {
	[Key in keyof T]?: T[Key] extends Array<infer Item>
		? Array<DeepPartial<Item>>
		: T[Key] extends object
			? DeepPartial<T[Key]>
			: T[Key];
};
