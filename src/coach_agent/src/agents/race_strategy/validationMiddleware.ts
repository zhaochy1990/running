import { RaceStrategyDirectResponseSchema } from "@stride/contract";
import { createSchemaValidationMiddleware } from "../schemaValidation.js";

/**
 * Machine-enforced contract for the race-strategy structured output: the
 * canonical schema's superRefines (cumulative-time consistency against the
 * target finish time) plus a bounded model retry, shared with the master-plan
 * generator via {@link createSchemaValidationMiddleware}.
 */
export function createRaceStrategyValidationMiddleware() {
  return createSchemaValidationMiddleware({
    name: "RaceStrategyValidationMiddleware",
    schema: RaceStrategyDirectResponseSchema,
    artifactLabel: "Race Strategy",
  });
}
