import { z } from "zod/v4";

export const DimensionId = z.enum(["background", "goals", "constraints", "ability", "training", "recovery", "injury", "preferences", "fueling", "response"]);
export type DimensionId = z.infer<typeof DimensionId>;
export const dimensions: Record<DimensionId, string> = {
  background: "基础信息与训练经历",
  goals: "训练目标与优先级",
  constraints: "训练时间与环境约束",
  ability: "当前运动能力",
  training: "训练结构与承受情况",
  recovery: "恢复能力与近期状态",
  injury: "伤病历史与当前限制",
  preferences: "执行习惯与训练偏好",
  fueling: "补给与比赛经验",
  response: "个体训练反应规律",
};
export const Nature = z.enum(["fact", "observation", "estimate", "preference", "goal", "constraint", "subjective", "association"]);
export type Nature = z.infer<typeof Nature>;
export const natureLabels: Record<Nature, string> = {
  fact: "记录事实",
  observation: "统计观察",
  estimate: "能力／模型估计",
  preference: "本人偏好",
  goal: "目标与优先级",
  constraint: "条件／限制",
  subjective: "本人感受",
  association: "关联规律",
};
export const Formation = z.enum(["direct", "fixed_calculation", "agent_extraction", "agent_exploration"]);
export const formationLabels = { direct: "直接引用", fixed_calculation: "固定代码计算", agent_extraction: "Agent原文提取", agent_exploration: "Agent探索" };
export const MetadataSchema = z.object({
  dimensionId: DimensionId,
  nature: Nature,
  sourceTypes: z.array(z.string()).min(1),
  formation: Formation,
  methodId: z.string(),
  computation: z.enum(["none", "predefined", "agent_authored", "legacy"]),
  supportingSources: z.array(z.object({ id: z.string(), revision: z.string() })).min(1),
  quotes: z.array(z.object({ sourceId: z.string(), text: z.string().min(1) })),
  producer: z.string(),
  reviewStatus: z.string().optional(),
  masterReview: z.object({ originalCandidateId: z.string(), validationReceiptIds: z.array(z.string()).min(1) }).optional(),
});

/** Work is delegated only where the snapshot can support exploration/extraction. */
export const workerScopes = {
  ability: ["ability", "background"],
  recovery: ["recovery", "training"],
  preferences: ["preferences", "goals", "constraints", "injury", "background"],
  fueling: ["fueling", "ability"],
  response: ["response"],
} satisfies Record<string, DimensionId[]>;
export const WorkerId = z.enum(["ability", "recovery", "preferences", "fueling", "response"]);
export type WorkerId = z.infer<typeof WorkerId>;
