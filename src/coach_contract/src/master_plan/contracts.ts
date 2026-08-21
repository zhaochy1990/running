import { z } from "zod/v4";
import { AssessmentFactsSchema, AthleteAssessmentSchema, GoalAssessmentSchema } from "./assessment-schemas.js";
import { adjudicateMasterPlanReviews, REQUIRED_REVIEWERS, ReviewAdjudicationSchema, ReviewReportSchema, ReviewWorkerErrorSchema } from "./review.js";
import { RuleReportSchema } from "./rules-schemas.js";
import { MasterPlanSchema, SelectedStrategySchema, StrategyCandidateSchema, StrategyJudgmentSchema } from "./schemas.js";
import { SimulationReportSchema } from "./simulation-schemas.js";

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

const CompletedOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("completed"),
  artifact: z
    .object({
      type: z.literal("master_plan_draft"),
      activation_status: z.literal("inactive"),
      plan: MasterPlanSchema,
      facts: AssessmentFactsSchema,
      athlete_assessment: AthleteAssessmentSchema,
      goal_assessment: GoalAssessmentSchema,
      strategy_candidates: z.array(StrategyCandidateSchema).min(2).max(3),
      judgments: z.array(StrategyJudgmentSchema).min(6).max(9),
      selected_strategy: SelectedStrategySchema,
      simulation_report: SimulationReportSchema,
      rule_report: RuleReportSchema,
      artifact_revision: z.int().positive(),
      review_reports: z.array(ReviewReportSchema).length(3),
      adjudication: ReviewAdjudicationSchema,
      warnings: z.array(z.string()),
    })
    .strict(),
})
  .strict()
  .superRefine((outcome, ctx) => {
    const ids = outcome.artifact.strategy_candidates.map((candidate) => candidate.candidate_id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "strategy_candidates"],
        message: "candidate IDs must be unique",
      });
    const judges = ["performance_path", "safety_load", "constraint_feasibility"];
    for (const id of ids) {
      const reports = outcome.artifact.judgments.filter((judgment) => judgment.candidate_id === id);
      if (reports.length !== 3 || new Set(reports.map((report) => report.judge)).size !== judges.length)
        ctx.addIssue({
          code: "custom",
          path: ["artifact", "judgments"],
          message: `candidate ${id} must have exactly three distinct judges`,
        });
    }
    if (outcome.artifact.judgments.some((judgment) => !ids.includes(judgment.candidate_id)))
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "judgments"],
        message: "judgments must reference an emitted candidate",
      });
    if (!ids.includes(outcome.artifact.selected_strategy.candidate.candidate_id))
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "selected_strategy"],
        message: "selected strategy must be one of the emitted candidates",
      });
    const reviewerTypes = outcome.artifact.review_reports.map((report) => report.reviewer_type);
    if (
      outcome.artifact.review_reports.some((report) => report.artifact_revision !== outcome.artifact.artifact_revision) ||
      REQUIRED_REVIEWERS.some((reviewer) => reviewerTypes.filter((item) => item === reviewer).length !== 1)
    )
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "review_reports"],
        message: "completed outcome requires one current report per required reviewer",
      });
    try {
      const expected = adjudicateMasterPlanReviews(outcome.artifact.artifact_revision, outcome.artifact.review_reports, outcome.artifact.facts, {
        simulation: outcome.artifact.simulation_report,
        rules: outcome.artifact.rule_report,
      });
      const expectedWarnings = expected.issues.filter((item) => item.severity === "warning").map((item) => item.issue_id);
      if (expected.decision === "revise" || expected.decision === "block" || JSON.stringify(expected) !== JSON.stringify(outcome.artifact.adjudication))
        ctx.addIssue({
          code: "custom",
          path: ["artifact", "adjudication"],
          message: "completed outcome requires the deterministic current adjudication",
        });
      if (JSON.stringify(expectedWarnings) !== JSON.stringify(outcome.artifact.warnings))
        ctx.addIssue({
          code: "custom",
          path: ["artifact", "warnings"],
          message: "warnings must match adjudicated warning issues",
        });
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "adjudication"],
        message: "completed outcome review evidence is invalid",
      });
    }
  });

const ReviewCompletedOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("review_completed"),
  artifact: z
    .object({
      type: z.enum(["plan_review_report", "revision_proposal"]),
      summary: z.string().min(1),
    })
    .strict(),
}).strict();

const PreviewCompletedOutcomeSchema = OutcomeIdentitySchema.extend({
  decision: z.literal("preview_completed"),
  artifact: z
    .object({
      type: z.literal("strategy_comparison"),
      summary: z.string().min(1),
    })
    .strict(),
}).strict();

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
      simulation_report: SimulationReportSchema.optional(),
      rule_report: RuleReportSchema.optional(),
      review_reports: z.array(ReviewReportSchema).optional(),
      adjudication: ReviewAdjudicationSchema.optional(),
      review_worker_errors: z.array(ReviewWorkerErrorSchema).optional(),
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
  ReviewCompletedOutcomeSchema,
  PreviewCompletedOutcomeSchema,
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
