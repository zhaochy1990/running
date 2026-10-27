// The model client config lives in `@stride/common`, next to the builders that
// consume it. Re-exported here so coach packages keep a single import site.
export type { ModelApiKind, ModelConfig, ReasoningEffort } from "@stride/common";

import type { ModelApiKind, ModelConfig, ReasoningEffort } from "@stride/common";

export interface RoleConfig {
  name: string;
  model: string;
  max_tokens?: number;
  timeout_s?: number;
  reasoning_effort?: ReasoningEffort;
  /** DeepSeek 思考模式开关；缺省 = 模型默认（思考开、effort high）。 */
  thinking?: "enabled" | "disabled";
  api_kind?: ModelApiKind;
  /** 采样温度（缺省 = buildModel 的 0.4）；结构化判断层调低以稳定过门（#810）。 */
  temperature?: number;
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
