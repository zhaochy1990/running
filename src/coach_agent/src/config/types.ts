export type ModelProvider = "openai-compatible" | "azure-openai";
export type ModelAuth = "api-key" | "managed-identity";
export type ModelApiKind = "chat-completions" | "responses";
export type ReasoningEffort = "low" | "medium" | "high" | "max";

export interface ModelConfig {
  name: string;
  provider: ModelProvider;
  model: string;
  deployment: string;
  endpoint: string;
  api_key_env: string;
  api_version?: string;
  auth: ModelAuth;
  api_kind: ModelApiKind;
  temperature?: number;
  max_tokens: number;
  timeout_s: number;
  reasoning_effort?: ReasoningEffort;
  /** DeepSeek 思考模式开关。缺省 = 保持模型默认（思考模式打开，effort 默认 high）。 */
  thinking?: "enabled" | "disabled";
  response_format?: "json_object";
}

export interface RoleConfig {
  name: string;
  model: string;
  max_tokens?: number;
  timeout_s?: number;
  reasoning_effort?: ReasoningEffort;
  /** DeepSeek 思考模式开关；缺省 = 模型默认（思考开、effort high）。 */
  thinking?: "enabled" | "disabled";
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
}

export type PartialCoachAgentConfig = DeepPartial<CoachAgentConfig>;

export type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends Array<infer Item> ? Array<DeepPartial<Item>> : T[Key] extends object ? DeepPartial<T[Key]> : T[Key];
};
