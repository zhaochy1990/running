import assert from "node:assert/strict";
import test from "node:test";
import {
  ContextSnapshotSchema,
  createMasterPlanGraph,
  deriveAssessmentFacts,
  GoalAssessmentSchema,
  type GoalAssessment,
  type MasterPlanGraphContext,
  MasterPlanGraphRequest,
  withBackfilledClaimCitations,
} from "./index.js";
import {
  createAssessmentSnapshot,
  createTestJudgments,
  createTestMasterPlan,
  createTestRequest,
  createTestReviewReport,
  createTestStrategyCandidate,
} from "./testFixtures.js";

const context: MasterPlanGraphContext = {
  userId: "athlete-344",
  generationId: "generation-344",
};

function validGoalAssessment() {
  return {
    schema_version: 2 as const,
    level: "aggressive_but_plausible" as const,
    summary: "The confirmed 2:50 goal is plausible only through explicit gates.",
    material_conclusions: [
      {
        claim: "goal_requires_improvement" as const,
        explanation: "The goal requires improvement over the matching PB.",
        fact_ids: ["goal.a.improvement_pct"],
      },
    ],
    abc_gates: {
      A: {
        target: {
          kind: "time" as const,
          time_seconds: 10200,
          label: "2:50:00",
        },
        conditions: [
          {
            signal: "race_specific_performance" as const,
            criterion: "Complete a race-specific validation effort",
            description: "Pass race-specific checks",
            fact_ids: ["goal.a.improvement_pct"],
          },
        ],
      },
      B: {
        target: {
          kind: "time" as const,
          time_seconds: 10380,
          label: "2:53:00",
        },
        conditions: [
          {
            signal: "race_specific_performance" as const,
            criterion: "Reassess when A validation is incomplete",
            description: "Use if A checks are incomplete",
            fact_ids: ["goal.a.matching_pb_seconds"],
          },
        ],
      },
      C: {
        target: {
          kind: "finish" as const,
          time_seconds: null,
          label: "Safe completion",
        },
        conditions: [
          {
            signal: "health_readiness" as const,
            criterion: "Start healthy enough to complete the race safely",
            description: "Protect health and completion",
            fact_ids: ["load.current_form"],
          },
        ],
      },
    },
    conflicts: [],
    multi_cycle_path: [],
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    contextProvider: {
      async loadSnapshot() {
        return createAssessmentSnapshot();
      },
      async loadActivities() {
        return [];
      },
    },
    goalAssessmentModel: {
      async invoke() {
        return validGoalAssessment();
      },
    },
    // 本文件只验 assess_goal 及之前的决策路径；L2/L4 模型在那些路径上不会被调用。
    phasingModel: {
      async invoke() {
        throw new Error("phasing model must not be invoked in assessment tests");
      },
    } as never,
    contentModel: {
      async invoke() {
        throw new Error("content model must not be invoked in assessment tests");
      },
    } as never,
    ...overrides,
  };
}

test("goal assessment requires operational gate criteria", () => {
  const assessment = validGoalAssessment();
  const condition = assessment.abc_gates.A.conditions[0]!;
  assert.throws(() =>
    GoalAssessmentSchema.parse({
      ...assessment,
      abc_gates: {
        ...assessment.abc_gates,
        A: {
          ...assessment.abc_gates.A,
          conditions: [
            {
              description: condition.description,
              fact_ids: condition.fact_ids,
            },
          ],
        },
      },
    }),
  );
});

test("rejects a goal gate whose fact id does not exist", async () => {
  const assessment = validGoalAssessment();
  assessment.abc_gates.A.conditions[0]!.fact_ids[0] = "invented.fact";
  const graph = createMasterPlanGraph(
    dependencies({
      goalAssessmentModel: {
        async invoke() {
          return assessment;
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context });
  assert.equal(outcome.decision, "failed_quality_gate");
});

test("rejects goal assessments that do not provide distinct A/B/C targets", async () => {
  const assessment = validGoalAssessment();
  assessment.abc_gates.B.target = { ...assessment.abc_gates.A.target };
  const graph = createMasterPlanGraph(
    dependencies({
      goalAssessmentModel: {
        async invoke() {
          return assessment;
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context });
  assert.equal(outcome.decision, "failed_quality_gate");
});

test("rejects B targets that are faster than the confirmed A target", async () => {
  const assessment = validGoalAssessment();
  assessment.abc_gates.B.target = {
    kind: "time",
    time_seconds: 10000,
    label: "2:46:40",
  };
  const graph = createMasterPlanGraph(
    dependencies({
      goalAssessmentModel: {
        async invoke() {
          return assessment;
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context });
  assert.equal(outcome.decision, "failed_quality_gate");
});

test("missing athlete baseline stops before goal assessment", async () => {
  let goalCalls = 0;
  const snapshot = createAssessmentSnapshot();
  snapshot.recent_history.weeks = [];
  const graph = createMasterPlanGraph(
    dependencies({
      contextProvider: {
        async loadSnapshot() {
          return snapshot;
        },
        async loadActivities() {
          return [];
        },
      },
      goalAssessmentModel: {
        async invoke() {
          goalCalls += 1;
          return validGoalAssessment();
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context });
  assert.equal(outcome.decision, "needs_baseline");
  assert.equal(goalCalls, 0);
});

test("assessment facts include complete zero-run weeks", async () => {
  const snapshot = createAssessmentSnapshot();
  snapshot.recent_history.weeks.at(-1)!.distance_km = 0;
  snapshot.recent_history.weeks.at(-1)!.run_count = 0;
  snapshot.recent_history.weeks.at(-1)!.run_day_count = 0;
  snapshot.recent_history.weeks.at(-1)!.long_run_km = 0;
  const facts = deriveAssessmentFacts(ContextSnapshotSchema.parse(snapshot), MasterPlanGraphRequest.parse(createTestRequest()));
  assert.equal(facts.facts.find((fact) => fact.fact_id === "frequency.recent_run_days_per_week")?.value, 5.5);
});

test("zero recent running baseline stops before any assessment model", async () => {
  const snapshot = createAssessmentSnapshot();
  for (const week of snapshot.recent_history.weeks.slice(-4)) {
    week.distance_km = 0;
    week.run_count = 0;
    week.run_day_count = 0;
    week.long_run_km = 0;
  }
  let modelCalls = 0;
  const graph = createMasterPlanGraph(
    dependencies({
      contextProvider: {
        async loadSnapshot() {
          return snapshot;
        },
        async loadActivities() {
          return [];
        },
      },
      goalAssessmentModel: {
        async invoke() {
          modelCalls += 1;
          return validGoalAssessment();
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request: createTestRequest() }, { context });
  assert.equal(outcome.decision, "needs_baseline");
  assert.equal(modelCalls, 0);
});

test("typed stop outcomes do not invoke the skeleton", async () => {
  let skeletonCalls = 0;
  const goal = {
    ...validGoalAssessment(),
    level: "multi_cycle_required" as const,
    multi_cycle_path: ["Build baseline", "Reassess target"],
  };
  const request = createTestRequest();
  request.goals[0]!.target_time = "2:10:00";
  goal.abc_gates.A.target = {
    kind: "time",
    time_seconds: 7800,
    label: "2:10:00",
  };
  const graph = createMasterPlanGraph(
    dependencies({
      goalAssessmentModel: {
        async invoke() {
          return goal;
        },
      },
      skeletonModel: {
        async invoke() {
          skeletonCalls += 1;
          return createTestMasterPlan();
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request }, { context });
  assert.equal(outcome.decision, "multi_cycle_required");
  assert.equal(skeletonCalls, 0);
});

test("explicit current acute restrictions stop before any assessment model", async () => {
  let modelCalls = 0;
  const request = createTestRequest();
  const injuredRequest = {
    ...request,
    injury_declarations: [
      {
        kind: "current" as const,
        body_area: "Achilles",
        status: "acute pain",
        training_impact: "stop running",
      },
    ],
  };
  const graph = createMasterPlanGraph(
    dependencies({
      goalAssessmentModel: {
        async invoke() {
          modelCalls += 1;
          return validGoalAssessment();
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request: injuredRequest }, { context });
  assert.equal(outcome.decision, "blocked_for_safety");
  assert.equal(modelCalls, 0);
});

test("a negated symptom does not hide a later explicit stop-running restriction", async () => {
  const request = MasterPlanGraphRequest.parse({
    ...createTestRequest(),
    injury_declarations: [
      {
        kind: "current",
        body_area: "Achilles",
        status: "no acute pain, but doctor says stop running",
        training_impact: "stop running",
      },
    ],
  });
  const graph = createMasterPlanGraph(dependencies());
  const { outcome } = await graph.invoke({ request }, { context });
  assert.equal(outcome.decision, "blocked_for_safety");
});

test("a conjunction does not let a negated injury hide a doctor restriction", async () => {
  const request = MasterPlanGraphRequest.parse({
    ...createTestRequest(),
    injury_declarations: [
      {
        kind: "current",
        body_area: "Achilles",
        status: "no acute injury and doctor restriction: stop running",
        training_impact: "stop running",
      },
    ],
  });
  const graph = createMasterPlanGraph(dependencies());
  const { outcome } = await graph.invoke({ request }, { context });
  assert.equal(outcome.decision, "blocked_for_safety");
});

test("an elapsed target race produces a goal conflict instead of a model-defined plan", async () => {
  const request = createTestRequest();
  request.goals[0]!.race_date = "2026-08-01";
  const goal = {
    ...validGoalAssessment(),
    level: "unsafe_or_incompatible" as const,
    conflicts: [
      {
        description: "Race date has elapsed",
        fact_ids: ["race.a.weeks_to_race"],
      },
    ],
  };
  const graph = createMasterPlanGraph(
    dependencies({
      goalAssessmentModel: {
        async invoke() {
          return goal;
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request }, { context });
  assert.equal(outcome.decision, "goal_conflict");
});

test("confirmed constraints incompatible with marathon preparation produce a goal conflict", async () => {
  const request = MasterPlanGraphRequest.parse({
    ...createTestRequest(),
    prohibited_arrangements: ["no long run"],
  });
  const goal = {
    ...validGoalAssessment(),
    level: "unsafe_or_incompatible" as const,
    conflicts: [
      {
        description: "Long runs are prohibited",
        fact_ids: ["constraints.goal_incompatible"],
      },
    ],
  };
  const graph = createMasterPlanGraph(
    dependencies({
      goalAssessmentModel: {
        async invoke() {
          return goal;
        },
      },
    }),
  );
  const { outcome } = await graph.invoke({ request }, { context });
  assert.equal(outcome.decision, "goal_conflict");
});

test("withBackfilledClaimCitations appends only known required facts", () => {
  const goal: GoalAssessment = {
    ...validGoalAssessment(),
    material_conclusions: [{ claim: "goal_supported_by_history", explanation: "x", fact_ids: ["history.peak_weekly_km"] }],
  };
  const facts = deriveAssessmentFacts(createAssessmentSnapshot(), createTestRequest());
  const backfilled = withBackfilledClaimCitations(goal, facts);
  assert.deepEqual(backfilled.material_conclusions[0]?.fact_ids, ["history.peak_weekly_km", "history.longest_road_run_km"]);
});
