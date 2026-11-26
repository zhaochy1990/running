import type { ToolRuntime } from "langchain";
import { z } from "zod/v4";
import { CoachTurnScope } from "./turnScope.js";

/** Per-turn runtime context threaded into the coach graph via the invoke config. */
export const CoachContext = z
  .object({
    userId: z.string().min(1),
    asof: z.iso.date(),
    /** API 层按 thread_id 计算后注入（#891 聊天内绑赛的线程定位），非客户端输入。 */
    threadId: z.string().min(1).optional(),
    /** From an ownership-checked review session in the API. */
    strengthReviewRecordId: z.guid().optional(),
    target: CoachTurnScope.shape.target,
    /** API 按请求来源标注，聊天内可用明确的新赛事替换此前绑定。 */
    raceTargetFromThread: z.boolean().optional(),
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
