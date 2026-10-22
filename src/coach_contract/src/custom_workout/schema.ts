import { z } from "zod/v4";
import { DirectResponseEnvelopeSchema } from "../master_plan/schema.js";
import { normalizeRunWorkout, type RunWorkout, RunWorkoutLenientSchema, RunWorkoutSchema } from "../workout/schema.js";

const DaySchema = z.iso.date();

/**
 * 用户自建单次训练课卡片（`custom-workout` $type，devops#587）——coach 把一句
 * 自然语言课表解析成规范 run-workout 后在聊天里的结构化产物。spec 是 canonical
 * run-workout/v1；save_token 是幂等保存键（卡片创建时由节点确定性生成，mp 点
 * 「保存/推送」凭它调 POST /api/users/me/custom-workouts upsert）。totals 与
 * estimated_dose 由节点确定性补齐（LLM 不算数），未校准时 dose 为 null。
 */
export const CustomWorkoutCardSchema = z.object({
  save_token: z.string().min(1),
  date: DaySchema,
  name: z.string().min(1),
  summary: z.string().min(1),
  /** 一句执行建议（可选）；配速明显超出校准区间时节点要求模型附提醒。 */
  advice: z.string().optional(),
  total_distance_m: z.number().nullable(),
  total_duration_s: z.number().nullable(),
  estimated_dose: z.number().nullable(),
  spec: RunWorkoutSchema,
  /** reissue 卡（devops#697）：save_token 复用了已存课的原令牌，mp 保存即原地更新同一行。 */
  reissue: z.boolean().optional(),
});
export type CustomWorkoutCard = z.infer<typeof CustomWorkoutCardSchema>;

/** 内层 agent 直出的业务四元组（裸对象防御解析同口径用）。 */
export const CustomWorkoutLenientContentSchema = z.object({
  date: DaySchema,
  name: z.string().min(1),
  summary: z.string().min(1),
  advice: z.string().optional(),
  /** 用户在调整一节已存课时，该课在注入列表里的 save_token；节点命中列表才复用。 */
  original_save_token: z.string().min(1).optional(),
  spec: RunWorkoutLenientSchema,
});

/**
 * 内层 agent 的直出草稿（lenient 容忍，ToolStrategy 信封）：模型只产出业务四
 * 元组 + 宽松 run-workout；save_token / totals / dose 由节点确定性补齐，模型
 * 给了也剥掉（避免「模型算的数」混进卡片）。
 */
export const CustomWorkoutLenientDirectResponseSchema = DirectResponseEnvelopeSchema.extend({
  content: CustomWorkoutLenientContentSchema,
});

/** lenient 信封 → 严格草稿：spec 经 normalizeRunWorkout 补默认后过硬校验。 */
export function normalizeCustomWorkoutDraft(content: z.infer<typeof CustomWorkoutLenientDirectResponseSchema>["content"]): {
  date: string;
  name: string;
  summary: string;
  advice?: string;
  original_save_token?: string;
  spec: RunWorkout;
} {
  return {
    date: content.date,
    name: content.name,
    summary: content.summary,
    ...(content.advice !== undefined ? { advice: content.advice } : {}),
    ...(content.original_save_token !== undefined ? { original_save_token: content.original_save_token } : {}),
    spec: normalizeRunWorkout(content.spec),
  };
}
