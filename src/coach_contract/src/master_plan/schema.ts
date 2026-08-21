import { z } from "zod/v4";
import { MasterPlanSchema } from "./schemas.js";

export type { MasterPlan } from "./schemas.js";
export { MasterPlanSchema };

export const DirectResponseEnvelopeSchema = z.object({
  disposition: z.literal("return_direct"),
  content: z.record(z.string(), z.unknown()),
});

export const MasterPlanDirectResponseSchema = DirectResponseEnvelopeSchema.extend({
  content: MasterPlanSchema,
});
