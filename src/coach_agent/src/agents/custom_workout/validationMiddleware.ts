import { CustomWorkoutLenientDirectResponseSchema } from "@stride/contract";
import { createSchemaValidationMiddleware } from "../schemaValidation.js";

/**
 * Machine-enforced contract for the custom-workout structured output: the
 * lenient envelope's hard rules (rest step must not carry a rest field, blocks
 * non-empty) plus a bounded model retry — same pattern as race-strategy.
 */
export function createCustomWorkoutValidationMiddleware() {
  return createSchemaValidationMiddleware({
    name: "CustomWorkoutValidationMiddleware",
    schema: CustomWorkoutLenientDirectResponseSchema,
    artifactLabel: "Custom Workout",
  });
}
