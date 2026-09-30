import { HumanMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod/v4";

const MAX_VALIDATION_RETRIES = 2;

const ValidationStateSchema = z.object({
  // 计数器键固定：两个消费者（master_plan / race_strategy 生成器）各自挂在
  // 不同 agent 实例上，状态互不相见。
  _schemaValidationRetries: z.int().nonnegative().default(0),
});

/**
 * Shared retry middleware for a sub-agent's structured output: re-parse the
 * model's `structuredResponse` against the canonical Zod schema (whose
 * superRefines — e.g. the race-strategy cumulative-time consistency — cannot be
 * expressed in the provider JSON Schema) and bounce the model once per issue
 * set instead of accepting an invalid artifact.
 */
export function createSchemaValidationMiddleware<Schema extends z.ZodType>(options: { name: string; schema: Schema; artifactLabel: string }) {
  const { name, schema, artifactLabel } = options;
  return createMiddleware({
    name,
    stateSchema: ValidationStateSchema,
    beforeAgent: () => ({ _schemaValidationRetries: 0 }),
    afterModel: {
      canJumpTo: ["model"],
      hook: (state) => {
        if (state.structuredResponse === undefined) return;
        const parsed = schema.safeParse(state.structuredResponse);
        if (parsed.success) return;

        const issues = formatIssues((parsed.error as z.ZodError).issues);
        if (state._schemaValidationRetries >= MAX_VALIDATION_RETRIES)
          throw new Error(`${artifactLabel} failed canonical validation after ${MAX_VALIDATION_RETRIES + 1} attempts: ${issues}`);

        return {
          _schemaValidationRetries: state._schemaValidationRetries + 1,
          messages: [
            new HumanMessage(
              `The proposed ${artifactLabel} failed canonical validation. Correct every issue and return the complete response again. Do not omit unchanged fields. Issues: ${issues}`,
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
