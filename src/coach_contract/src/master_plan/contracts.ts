import { z } from "zod/v4";
import { AssessmentFactsSchema, GoalAssessmentSchema } from "./assessment-schemas.js";
import { DanielsAuditSchema, LoadPlanSchema, MasterPlanAnchorSchema, PhaseDivisionIntentSchema } from "./policy.js";
import { MasterPlanSchema } from "./schemas.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RACE_TIME = /^\d{1,2}:[0-5]\d:[0-5]\d$/;
const identifier = z.string().min(1);
const weekday = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

const GoalSchema = z
  .object({
    race_name: z.string().min(1),
    location: z.string().min(1).nullish(),
    distance: z.enum(["FM", "HM"]),
    race_date: z.string().regex(DAY),
    target_time: z.string().regex(RACE_TIME, "expected H:MM:SS").nullable(),
    finish_only: z.boolean(),
    priority: z.enum(["A", "B", "C"]),
  })
  .strict()
  .superRefine((goal, ctx) => {
    if (goal.finish_only === (goal.target_time !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["target_time"],
        message: "provide a target_time or explicitly select finish_only",
      });
    }
  });

const AvailabilitySchema = z
  .object({
    weekly_run_days_max: z.int().min(1).max(7),
    available_training_windows: z.array(
      z
        .object({
          day: weekday,
          start_time: z.string().regex(TIME),
          end_time: z.string().regex(TIME),
        })
        .strict(),
    ),
    unavailable_days: z.array(weekday),
    max_session_duration_min: z.int().positive(),
    allows_double_sessions: z.boolean(),
    preferred_long_run_day: weekday.nullable(),
    strength_sessions_per_week: z.int().nonnegative(),
    strength_available_days: z.array(weekday),
  })
  .strict();

const InjuryDeclarationSchema = z
  .object({
    kind: z.enum(["current", "historical"]),
    body_area: z.string().min(1),
    status: z.string().min(1),
    training_impact: z.string().min(1),
  })
  .strict();

export const MasterPlanGraphRequest = z
  .object({
    request_id: identifier,
    requested_mode: z.enum([
      "general_fitness",
      "base_development",
      "weight_management",
      "new_season",
      "continue_existing",
      "replan_remaining_season",
      "race_salvage",
      "taper_only",
      "completion_strategy",
      "post_race_transition",
      "return_to_run",
      "multi_race_season",
      "review_existing_strategy",
      "coach_collaboration",
      "strategy_preview",
      "scenario_comparison",
      "baseline_assessment",
      "goal_negotiation",
      "multi_cycle_development",
    ]),
    requested_modifiers: z.array(z.string().min(1)),
    goals: z.array(GoalSchema).min(1),
    availability: AvailabilitySchema,
    injury_declarations: z.array(InjuryDeclarationSchema),
    environment_constraints: z.array(z.string().min(1)),
    travel_constraints: z.array(z.string().min(1)),
    preferences: z.array(z.string().min(1)),
    prohibited_arrangements: z.array(z.string().min(1)),
    active_plan_action: z.enum(["none", "continue", "replan_remaining", "replace", "review_only"]),
    source_artifact_ref: z.string().min(1).optional(),
    comparison_hypotheses: z.array(z.string().min(1)).optional(),
    user_confirmations: z
      .object({
        intake_complete: z.literal(true),
        goals_confirmed: z.literal(true),
        availability_confirmed: z.literal(true),
        injury_history_confirmed: z.literal(true),
        constraints_confirmed: z.literal(true),
      })
      .strict(),
    requested_as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.goals.filter((goal) => goal.priority === "A").length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["goals"],
        message: "exactly one primary A-priority goal is required",
      });
    }
  });
export type MasterPlanGraphRequest = z.infer<typeof MasterPlanGraphRequest>;

export const MasterPlanGraphContext = z
  .object({
    userId: identifier,
    generationId: identifier,
  })
  .strict();
export type MasterPlanGraphContext = z.infer<typeof MasterPlanGraphContext>;

const OutcomeIdentitySchema = z.object({
  request_id: identifier,
  generation_id: identifier,
});

/**
 * completed 产物（#803 kernel 新拓扑）：政策包四段 + 首期课表快照（v2 形状）。
 * 老 strategies/judges/reviews 三分支证据面随老 kernel 一起删除（2026-11-08 拍板
 * 直接 breaking，不做双拓扑）；确定性质量证据改由 L3 六门 + L4 C/P 门 + danielsAudit
 * 承担，审计结果落在 artifact.audit 里（不再是「九次评审的裁决」）。
 */
const CompletedOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("completed"),
  artifact: z
    .object({
      type: z.literal("master_plan_draft"),
      activation_status: z.literal("inactive"),
      /** 首期课表快照（v2 形状）：policy/skeleton 的可读投影，落库时进 v3 的 v2 字段。 */
      plan: MasterPlanSchema,
      facts: AssessmentFactsSchema,
      goal_assessment: GoalAssessmentSchema,
      policy: PhaseDivisionIntentSchema,
      skeleton: LoadPlanSchema,
      anchor: MasterPlanAnchorSchema,
      audit: DanielsAuditSchema,
      artifact_revision: z.int().positive(),
      warnings: z.array(z.string()),
    })
    .strict(),
})
  .strict()
  .superRefine((outcome, ctx) => {
    const { plan, policy, skeleton, audit } = outcome.artifact;
    // 政策包与首期快照是同一份计划的两种视图，三条跨契约不变量任一破 = 组装缺陷。
    const policyWeeks = Math.max(...policy.phases.map((phase) => phase.end_week));
    if (plan.total_weeks !== policyWeeks)
      ctx.addIssue({ code: "custom", path: ["artifact", "plan", "total_weeks"], message: "must equal the last policy phase end_week" });
    if (skeleton.weeks.length !== policyWeeks)
      ctx.addIssue({ code: "custom", path: ["artifact", "skeleton", "weeks"], message: "must cover every policy week exactly once" });
    if (plan.weeks.length !== skeleton.weeks.length)
      ctx.addIssue({ code: "custom", path: ["artifact", "plan", "weeks"], message: "snapshot must cover every skeleton week" });
    const { pass, warn, fail } = audit.summary;
    if (pass + warn + fail !== audit.items.length)
      ctx.addIssue({ code: "custom", path: ["artifact", "audit", "summary"], message: "must count every audit item" });
  });

const NeedsClarificationOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("needs_clarification"),
  questions: z
    .array(
      z
        .object({
          question_id: identifier,
          intent: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
}).strict();

const NeedsBaselineOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("needs_baseline"),
  artifact: z
    .object({
      type: z.literal("baseline_requirements"),
      missing: z.array(z.string().min(1)).min(1),
      next_steps: z.array(z.string().min(1)).min(1),
    })
    .strict(),
}).strict();

const GoalConflictOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("goal_conflict"),
  artifact: z
    .object({
      type: z.literal("goal_options"),
      conflicts: z.array(z.string().min(1)).min(1),
      options: z.array(z.string().min(1)).min(1),
    })
    .strict(),
}).strict();

const MultiCycleRequiredOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("multi_cycle_required"),
  artifact: z
    .object({
      type: z.literal("multi_cycle_path"),
      cycles: z.array(z.string().min(1)).min(2),
    })
    .strict(),
}).strict();

const BlockedForSafetyOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("blocked_for_safety"),
  reasons: z.array(z.string().min(1)).min(1),
  prerequisites: z.array(z.string().min(1)).min(1),
}).strict();

const UnsupportedOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("unsupported"),
  artifact: z
    .object({
      type: z.literal("capability_gap"),
      requested_mode: MasterPlanGraphRequest.shape.requested_mode,
      supported_modes: z.array(z.literal("new_season")),
    })
    .strict(),
}).strict();

const FailedQualityGateOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("failed_quality_gate"),
  artifact: z
    .object({
      type: z.literal("quality_failure_report"),
      unresolved_issues: z.array(z.string().min(1)).min(1),
      attempt_history: z.array(z.string().min(1)),
    })
    .strict(),
}).strict();

const InfrastructureFailureOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("infrastructure_failure"),
  code: z.string().min(1),
  retryable: z.boolean(),
}).strict();

export const MasterPlanGraphOutcome = z.discriminatedUnion("decision", [
  CompletedOutcomeSchema,
  NeedsClarificationOutcomeSchema,
  NeedsBaselineOutcomeSchema,
  GoalConflictOutcomeSchema,
  MultiCycleRequiredOutcomeSchema,
  BlockedForSafetyOutcomeSchema,
  UnsupportedOutcomeSchema,
  FailedQualityGateOutcomeSchema,
  InfrastructureFailureOutcomeSchema,
]);
export type MasterPlanGraphOutcome = z.infer<typeof MasterPlanGraphOutcome>;
