import { z } from "zod/v4";
import { MasterPlanGraphRequest } from "./contracts.js";

/**
 * A plan proposal (计划提案) is what the Coach drafts instead of a complete
 * plan (ADR 0030, Pattern X): a structured kernel request plus a Chinese
 * summary, rendered as a confirmation card in chat. The athlete confirms it
 * and only then does the deterministic endpoint enqueue a plan job.
 *
 * `kind` doubles as the plan-job `job_type` and stays intentionally narrow —
 * only the kinds whose kernel is actually wired (mirrors PLAN_JOB_TYPES).
 */
export const PLAN_PROPOSAL_KINDS = ["generate_master_plan"] as const;
export type PlanProposalKind = (typeof PLAN_PROPOSAL_KINDS)[number];

export const PlanProposalSchema = z
  .object({
    kind: z.enum(PLAN_PROPOSAL_KINDS),
    /** 面向运动员的中文摘要，确认卡片正文。 */
    summary: z.string().min(1),
    /** Kernel 请求，经确定性端点入队前会被服务端 zod 复验。 */
    request: MasterPlanGraphRequest,
  })
  .strict();
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

/** The generator subagent's `return_direct` envelope for a drafted proposal. */
export const PlanProposalDirectResponseSchema = z
  .object({
    disposition: z.literal("return_direct"),
    content: PlanProposalSchema,
  })
  .strict();

/**
 * Discriminator for the confirmation message the chat layer appends to a
 * thread after enqueueing a plan job (ADR 0030). The history flattener
 * recognizes it and renders a generation card (job_id + job_type) instead of a
 * plain assistant bubble.
 */
export const PLAN_JOB_CONFIRMATION_KIND = "plan_job_confirmed";

export const PlanJobConfirmationSchema = z
  .object({
    kind: z.literal(PLAN_JOB_CONFIRMATION_KIND),
    job_id: z.string().min(1),
    job_type: z.string().min(1),
  })
  .strict();
export type PlanJobConfirmation = z.infer<typeof PlanJobConfirmationSchema>;
