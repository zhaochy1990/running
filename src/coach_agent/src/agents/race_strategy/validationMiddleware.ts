import { HumanMessage } from "@langchain/core/messages";
import { RaceStrategyDirectResponseSchema } from "@stride/contract";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";

const MAX_VALIDATION_RETRIES = 2;

const ValidationStateSchema = z.object({
  _raceStrategyValidationRetries: z.int().nonnegative().default(0),
});

/**
 * Enforce Zod refinements the provider JSON Schema cannot express, and the
 * pace-table arithmetic (cumulative time consistency against the target) that
 * matters most for a race strategy. Mirrors the master-plan middleware.
 */
export function createRaceStrategyValidationMiddleware() {
  return createMiddleware({
    name: "RaceStrategyValidationMiddleware",
    stateSchema: ValidationStateSchema,
    beforeAgent: () => ({ _raceStrategyValidationRetries: 0 }),
    afterModel: {
      canJumpTo: ["model"],
      hook: (state) => {
        if (state.structuredResponse === undefined) return;
        const parsed = RaceStrategyDirectResponseSchema.safeParse(state.structuredResponse);
        if (parsed.success) return;

        const issues = formatIssues(parsed.error.issues);
        if (state._raceStrategyValidationRetries >= MAX_VALIDATION_RETRIES)
          throw new Error(`Race strategy failed canonical validation after ${MAX_VALIDATION_RETRIES + 1} attempts: ${issues}`);

        return {
          _raceStrategyValidationRetries: state._raceStrategyValidationRetries + 1,
          messages: [
            new HumanMessage(
              `The proposed Race Strategy failed canonical validation. Correct every issue and return the complete response again. Do not omit unchanged fields. Issues: ${issues}`,
            ),
          ],
          jumpTo: "model" as const,
        };
      },
    },
  });
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
}
