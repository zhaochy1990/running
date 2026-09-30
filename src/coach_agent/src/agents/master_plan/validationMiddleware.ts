import { MasterPlanDirectResponseSchema } from "@stride/contract";
import { createSchemaValidationMiddleware } from "../schemaValidation.js";

/** Enforce Zod cross-field refinements that provider JSON Schema cannot express. */
export function createMasterPlanValidationMiddleware() {
  return createSchemaValidationMiddleware({
    name: "MasterPlanValidationMiddleware",
    schema: MasterPlanDirectResponseSchema,
    artifactLabel: "Master Plan",
  });
}
