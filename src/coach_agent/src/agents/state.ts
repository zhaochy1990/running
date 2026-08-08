import { MessagesValue, ReducedValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { GenInputPayload, MasterPlanContext } from "./master_plan/types.js";

// Structured output of the intent classifier; also the type of the `intent`
// state channel the orchestrator writes to.
export const IntentClassificationSchema = z.object({
    intent: z.enum(["weekly_plan", "master_plan", "training_question", "other"]),
    // topic: z.string(),
    // summary: z.string(),
});

/** The intent labels the orchestrator classifies into (used for goto routing). */
export type IntentLabel = z.infer<typeof IntentClassificationSchema>["intent"];

// The single shared agent state. Carries the S3 orchestrator channels
// (messages / intent / llmCalls) AND the S1 master-plan generation channels
// (inputPayload / context) — the former GenState is converged in here.
export const AgentsState = new StateSchema({
    userId: z.string(),
    messages: MessagesValue,
    llmCalls: new ReducedValue(
        z.number().default(0),
        { reducer: (x, y) => x + y }
    ),
    intent: IntentClassificationSchema.nullable().default(null),
    // S1 master-plan generation channels (converged from the former GenState).
    inputPayload: z.custom<GenInputPayload | null>().default(null),
    context: z.custom<MasterPlanContext | null>().default(null),
});
