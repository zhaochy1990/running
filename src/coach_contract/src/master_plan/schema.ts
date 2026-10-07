import { z } from "zod/v4";
import { MasterPlanLenientSchema, MasterPlanSchema } from "./schemas.js";

export type { MasterPlan } from "./schemas.js";
export { MasterPlanLenientSchema, MasterPlanSchema };

export const DirectResponseEnvelopeSchema = z.object({
  disposition: z.literal("return_direct"),
  content: z.record(z.string(), z.unknown()),
});

export const MasterPlanDirectResponseSchema = DirectResponseEnvelopeSchema.extend({
  content: MasterPlanSchema,
});

/** 宽松版信封：content 只做形状解析，跳过跨字段确定性规则（临时，质量门停用期）。 */
export const MasterPlanLenientDirectResponseSchema = DirectResponseEnvelopeSchema.extend({
  content: MasterPlanLenientSchema,
});
