import type { ToolRuntime } from "langchain";
import { z } from "zod/v4";
import { CoachTurnScope } from "./turnScope.js";

/** Per-turn runtime context threaded into the coach graph via the invoke config. */
export const CoachContext = z
  .object({
    userId: z.string().min(1),
    asof: z.iso.date(),
    target: CoachTurnScope.shape.target,
    reviewContext: CoachTurnScope.shape.reviewContext,
  })
  .strict()
  .superRefine((value, context) => {
    const scoped = CoachTurnScope.safeParse({
      target: value.target,
      reviewContext: value.reviewContext,
    });
    if (!scoped.success) {
      for (const issue of scoped.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    }
  });

export type CoachToolRuntime = ToolRuntime<unknown, typeof CoachContext>;
