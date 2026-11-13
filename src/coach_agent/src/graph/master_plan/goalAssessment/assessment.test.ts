import assert from "node:assert/strict";
import test from "node:test";
import {
  authoritativeGoalLevel,
  ContextSnapshotSchema,
  createMasterPlanGraph,
  deriveAssessmentFacts,
  type GoalAssessment,
  GoalAssessmentSchema,
  type MasterPlanGraphContext,
  type MasterPlanGraphDependencies,
  MasterPlanGraphRequest,
  validateAssessmentReferences,
  withBackfilledClaimCitations,
} from "../index.js";
import { createAssessmentSnapshot, createTestMasterPlan, createTestRequest } from "../testFixtures.js";

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

test("race runway uses unrounded Shanghai generation-day weeks, not scheduling weeks", () => {
  const request = MasterPlanGraphRequest.parse({ ...createTestRequest(), requested_as_of: "2026-11-13T04:00:00Z" });
  request.goals[0]!.race_date = "2027-02-07";
  const snapshot = ContextSnapshotSchema.parse({ ...createAssessmentSnapshot(), as_of: request.requested_as_of });
  const facts = deriveAssessmentFacts(snapshot, request);
  assert.equal(facts.facts.find((fact) => fact.fact_id === "race.a.weeks_to_race")?.value, 12.285714285714286);
});

function novemberScenario(asOf = "2026-11-13T04:00:00Z", raceDate = "2027-02-07") {
  const request = MasterPlanGraphRequest.parse({ ...createTestRequest(), requested_as_of: asOf });
  request.goals[0]!.race_date = raceDate;
  return { request, snapshot: ContextSnapshotSchema.parse({ ...createAssessmentSnapshot(), as_of: asOf, plan_start: "2026-11-16" }) };
}
function runwayAssessment(only = false): GoalAssessment {
  const assessment: GoalAssessment = validGoalAssessment();
  assessment.material_conclusions = [
    ...(only ? [] : assessment.material_conclusions),
    { claim: "goal_runway_limited", explanation: "Only 12 scheduling weeks remain", fact_ids: ["race.a.weeks_to_race"] },
  ];
  return assessment;
}
async function assessmentUpdate(model: MasterPlanGraphDependencies["goalAssessmentModel"]) {
  const { request, snapshot } = novemberScenario();
  const graph = createMasterPlanGraph(
    dependencies({
      contextProvider: { loadSnapshot: async () => snapshot, loadActivities: async () => [] },
      goalAssessmentModel: model,
    }),
  );
  for await (const update of await graph.stream({ request }, { context, streamMode: "updates" })) {
    if ("assess_goal" in update) return update.assess_goal as { goalAssessment?: GoalAssessment; outcome?: { decision: string } };
  }
  throw new Error("assessment update missing");
}

test("a spurious runway claim is corrected without losing valid conclusions or gates", async () => {
  let calls = 0;
  const update = await assessmentUpdate({
    invoke: async () => {
      calls++;
      return runwayAssessment();
    },
  });
  assert.equal(update.outcome, undefined);
  assert.equal(calls, 1);
  assert.deepEqual(
    update.goalAssessment?.material_conclusions.map((item) => item.claim),
    ["goal_requires_improvement"],
  );
  assert.deepEqual(update.goalAssessment?.abc_gates, validGoalAssessment().abc_gates);
  assert.doesNotMatch(update.goalAssessment!.summary, /runway|scheduling/i);
});

test("a sole unsupported runway conclusion retries once with facts, never an empty assessment", async () => {
  const retries: Array<{ violations: string[] } | undefined> = [];
  const update = await assessmentUpdate({
    invoke: async (_input, retry) => {
      retries.push(retry);
      return retry ? validGoalAssessment() : runwayAssessment(true);
    },
  });
  assert.equal(retries.length, 2);
  assert.equal(retries[0], undefined);
  assert.match(retries[1]!.violations.join(" "), /12\.285714.*not <12/);
  assert.ok(update.goalAssessment?.material_conclusions.length);
  assert.equal(update.outcome, undefined);
});

test("a repeated sole runway contradiction fails after one retry", async () => {
  let calls = 0;
  const update = await assessmentUpdate({
    invoke: async () => {
      calls++;
      return runwayAssessment(true);
    },
  });
  assert.equal(calls, 2);
  assert.equal(update.outcome?.decision, "failed_quality_gate");
  assert.equal(update.goalAssessment, undefined);
});

test("runway correction cannot mask unknown references, invalid targets or other unsupported claims", async () => {
  for (const corrupt of [
    (goal: GoalAssessment) => {
      goal.material_conclusions[1]!.fact_ids.push("invented.fact");
    },
    (goal: GoalAssessment) => {
      goal.abc_gates.A.target.time_seconds = 10000;
    },
    (goal: GoalAssessment) => {
      goal.material_conclusions[0]!.claim = "goal_supported_by_history";
      goal.material_conclusions.reverse();
    },
  ]) {
    const goal = runwayAssessment();
    corrupt(goal);
    let calls = 0;
    const scenario = novemberScenario();
    // Deliberately remove durability evidence in the third corruption case.
    const snapshot = ContextSnapshotSchema.parse({ ...scenario.snapshot, macro_history: { ...scenario.snapshot.macro_history, longest_road_run_km: null } });
    const graph = createMasterPlanGraph(
      dependencies({
        contextProvider: { loadSnapshot: async () => snapshot, loadActivities: async () => [] },
        goalAssessmentModel: {
          invoke: async () => {
            calls++;
            return goal;
          },
        },
      }),
    );
    const { outcome } = await graph.invoke({ request: scenario.request }, { context });
    assert.equal(outcome.decision, "failed_quality_gate");
    assert.equal(calls, 1);
  }
});

test("<12, =12, >12 exact-week claims share a 12-week Monday schedule", async () => {
  const { planningStartDate, shanghaiDay } = await import("@stride/contract");
  for (const [asOf, runway, limited, raceDate] of [
    ["2026-11-16T00:00:00+08:00", 11.857142857142858, true, "2027-02-07"],
    ["2026-11-15T00:00:00+08:00", 12, false, "2027-02-07"],
    ["2026-11-14T00:00:00+08:00", 12.142857142857142, false, "2027-02-07"],
    ["2026-11-15T15:59:59Z", 12, false, "2027-02-07"],
    ["2026-11-15T16:00:00Z", 11.857142857142858, true, "2027-02-07"],
    ["2026-11-13T04:00:00Z", 11.857142857142858, true, "2027-02-04"],
    ["2026-11-13T04:00:00Z", 12, false, "2027-02-05"],
    ["2026-11-13T04:00:00Z", 12.142857142857142, false, "2027-02-06"],
  ] as const) {
    const { request, snapshot } = novemberScenario(asOf, raceDate);
    assert.equal(planningStartDate(shanghaiDay(asOf)), "2026-11-16");
    assert.equal(Math.ceil((Date.parse(`${raceDate}T00:00:00Z`) - Date.parse("2026-11-16T00:00:00Z")) / (7 * 86_400_000)), 12);
    const facts = deriveAssessmentFacts(snapshot, request);
    assert.equal(facts.facts.find((fact) => fact.fact_id === "race.a.weeks_to_race")?.value, runway);
    const goal = runwayAssessment();
    if (limited) assert.doesNotThrow(() => validateAssessmentReferences(goal, facts));
    else assert.throws(() => validateAssessmentReferences(goal, facts), /contradicts deterministic facts/);
    // Isolate the runway rung of the authoritative ladder from PB improvement.
    const ladderFacts = { ...facts, facts: facts.facts.map((fact) => (fact.fact_id === "goal.a.improvement_pct" ? { ...fact, value: 0 } : fact)) };
    assert.equal(authoritativeGoalLevel(ladderFacts), limited ? "aggressive_but_plausible" : "supported");
    const graph = createMasterPlanGraph(
      dependencies({
        contextProvider: { loadSnapshot: async () => snapshot, loadActivities: async () => [] },
        goalAssessmentModel: { invoke: async () => goal },
      }),
    );
    let assessed = false;
    for await (const update of await graph.stream({ request }, { context, streamMode: "updates" })) {
      if (!("assess_goal" in update)) continue;
      assessed = true;
      const assessment = (update.assess_goal as { goalAssessment: GoalAssessment }).goalAssessment;
      assert.equal(
        assessment.material_conclusions.some((item) => item.claim === "goal_runway_limited"),
        limited,
      );
      assert.doesNotThrow(() => validateAssessmentReferences(assessment, facts));
      if (limited) assert.match(assessment.summary, /less than 12 exact weeks.*Shanghai generation day/);
      break;
    }
    assert.ok(assessed, "assessment node must actually execute");
  }
});

test("6/12/18/24 natural-week paths complete with unchanged confirmed goals after runway correction", async () => {
  const { addDays } = await import("@stride/contract");
  const { FrozenMasterPlanContextProvider } = await import("../context.js");
  const activities = Array.from({ length: 28 }, (_, i) => ({
    shanghaiDay: addDays("2026-11-09", -7 * i),
    distanceM: 65000,
    name: "easy",
    strideSessionClass: "easy",
    sport: "run",
  }));
  for (const weeks of [6, 12, 18, 24]) {
    const { request, snapshot } = novemberScenario("2026-11-13T04:00:00Z", addDays("2026-11-16", weeks * 7 - 1));
    request.availability.unavailable_days = [];
    request.availability.preferred_long_run_day = "sunday";
    const graph = createMasterPlanGraph({
      contextProvider: new FrozenMasterPlanContextProvider(snapshot, activities),
      goalAssessmentModel: { invoke: async () => runwayAssessment() },
      // Existing deterministic phasing/content fallbacks are exercised, not fabricated plan output.
      phasingModel: {
        invoke: async () => {
          throw new Error("fixture fallback");
        },
      },
      contentModel: {
        invoke: async () => {
          throw new Error("fixture fallback");
        },
      },
    });
    const { outcome } = await graph.invoke({ request }, { context });
    assert.equal(outcome.decision, "completed", JSON.stringify(outcome));
    if (outcome.decision !== "completed") throw new Error("expected completed");
    const { plan, goal_assessment, facts, skeleton, audit } = outcome.artifact;
    assert.equal(plan.total_weeks, weeks);
    assert.equal(plan.start_date, "2026-11-16");
    assert.equal(plan.goal.distance, "FM");
    assert.equal(plan.goal.target_time, "2:50:00");
    assert.equal(plan.goal.race_date, request.goals[0]!.race_date);
    assert.equal(
      goal_assessment.material_conclusions.some((item) => item.claim === "goal_runway_limited"),
      weeks === 6,
    );
    assert.doesNotThrow(() => validateAssessmentReferences(goal_assessment, facts!));
    assert.ok(skeleton.checks.every((check) => check.pass));
    assert.equal(audit.summary.fail, 0);
  }
});

test("missing runway facts are not fabricated or corrected", () => {
  const { request, snapshot } = novemberScenario();
  const facts = deriveAssessmentFacts(snapshot, request);
  const unknownRunway = { ...facts, facts: facts.facts.map((fact) => (fact.fact_id === "race.a.weeks_to_race" ? { ...fact, value: null } : fact)) };
  assert.throws(() => validateAssessmentReferences(runwayAssessment(), unknownRunway), /contradicts deterministic facts/);
});

test("an irrecoverable contract error after the runway retry remains a failure", async () => {
  let calls = 0;
  const update = await assessmentUpdate({
    invoke: async (_input, retry) => {
      calls++;
      return retry ? { ...validGoalAssessment(), material_conclusions: [] } : runwayAssessment(true);
    },
  });
  assert.equal(calls, 2);
  assert.equal(update.outcome?.decision, "failed_quality_gate");
});

test("domain errors containing infrastructure keywords remain permanent quality failures", async () => {
  const update = await assessmentUpdate({
    invoke: async () => {
      const goal = runwayAssessment();
      goal.material_conclusions[0]!.fact_ids.push("invented.unavailable");
      return goal;
    },
  });
  assert.equal(update.outcome?.decision, "failed_quality_gate");
});

test("explicit generation-to-race text contradictions retry without deleting gates", async () => {
  for (const text of ["从上海生成日至比赛日不足12周", "From the Shanghai generation day to the race date is less than 12 weeks"]) {
    let calls = 0;
    const goal = runwayAssessment();
    goal.abc_gates.A.conditions[0]!.description = text;
    const update = await assessmentUpdate({
      invoke: async (_input, retry) => {
        calls++;
        if (retry) assert.match(retry.violations.join(" "), /generation-day runway.*not <12/);
        return retry ? validGoalAssessment() : goal;
      },
    });
    assert.equal(calls, 2);
    assert.equal(update.outcome, undefined);
    assert.deepEqual(update.goalAssessment?.abc_gates, validGoalAssessment().abc_gates);
  }
});

test("runway text checks do not confuse scheduling, phase duration, quotes or negation", async () => {
  for (const text of [
    "排课有12个自然训练周",
    "基础阶段不足12周",
    "从生成日至比赛日计划中的基础阶段不足12周",
    "并非从上海生成日至比赛日不足12周",
    "不要声称从上海生成日至比赛日不足12周",
    "不能认为从上海生成日至比赛日不足12周",
    "Do not assert from the Shanghai generation day to the race date is less than 12 weeks",
    "引用：‘从上海生成日至比赛日不足12周’不是本次结论",
    "The training phase is less than 12 weeks",
    "From the Shanghai generation day to the race date is not less than 12 weeks",
    'Do not assert "From the Shanghai generation day to the race date is less than 12 weeks"',
  ]) {
    let calls = 0;
    const goal = runwayAssessment();
    goal.conflicts = [{ description: text, fact_ids: ["race.a.weeks_to_race"] }];
    const update = await assessmentUpdate({
      invoke: async () => {
        calls++;
        return goal;
      },
    });
    assert.equal(calls, 1, text);
    assert.equal(update.outcome, undefined, text);
    assert.deepEqual(update.goalAssessment?.conflicts, goal.conflicts);
  }
});

test("claim and text contradictions share one retry budget and keep explicit failure", async () => {
  let calls = 0;
  const update = await assessmentUpdate({
    invoke: async (_input, retry) => {
      calls++;
      if (!retry) return runwayAssessment(true);
      const goal: GoalAssessment = validGoalAssessment();
      goal.conflicts = [{ description: "从上海生成日到比赛日不足12周", fact_ids: ["race.a.weeks_to_race"] }];
      return goal;
    },
  });
  assert.equal(calls, 2);
  assert.equal(update.outcome?.decision, "failed_quality_gate");
});

test("Responses adapter decodes a false claim and forwards the single retry feedback", async () => {
  const { createMasterPlanLlmModels } = await import("../llm/models.js");
  const envName = "RUNWAY_TEST_MODEL_KEY";
  const previousKey = process.env[envName];
  const previousFetch = globalThis.fetch;
  process.env[envName] = "test-only";
  const modelConfig = {
    name: "runway-test",
    model: "test-model",
    endpoint: "http://127.0.0.1:1/v1",
    api_kind: "responses" as const,
    api_key_env: envName,
    max_tokens: 2048,
    timeout_s: 1,
  };
  try {
    for (const only of [false, true]) {
      const wires: Array<{ text: { format: { name: string; type: string } }; input: unknown }> = [];
      globalThis.fetch = async (_url, init) => {
        const wire = JSON.parse(String(init?.body));
        wires.push(wire);
        const assessment = wires.length === 1 ? runwayAssessment(only) : validGoalAssessment();
        return new Response(
          JSON.stringify({
            id: `resp_${wires.length}`,
            object: "response",
            created_at: 1,
            status: "completed",
            model: "test-model",
            output: [
              {
                id: `msg_${wires.length}`,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: JSON.stringify(assessment), annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      };
      const models = createMasterPlanLlmModels({ masterPlanModel: modelConfig, phasingModel: modelConfig, contentModel: modelConfig });
      const update = await assessmentUpdate(models.goalAssessmentModel);
      assert.equal(update.outcome, undefined);
      assert.equal(wires.length, only ? 2 : 1);
      assert.ok(wires.every((wire) => wire.text.format.name === "submit_goal_assessment" && wire.text.format.type === "json_schema"));
      assert.match(JSON.stringify(wires[0]!.input), /NOT the number of natural training weeks/);
      if (only) assert.match(JSON.stringify(wires[1]!.input), /generation-day runway.*not <12/);
      assert.ok(update.goalAssessment?.material_conclusions.every((item) => item.claim !== "goal_runway_limited"));
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env[envName];
    else process.env[envName] = previousKey;
  }
});

test("persistent explicit runway text contradictions fail after one feedback retry", async () => {
  let calls = 0;
  const goal = runwayAssessment();
  goal.conflicts = [{ description: "从上海生成日到比赛日不足12周", fact_ids: ["race.a.weeks_to_race"] }];
  const update = await assessmentUpdate({
    invoke: async () => {
      calls++;
      return goal;
    },
  });
  assert.equal(calls, 2);
  assert.equal(update.outcome?.decision, "failed_quality_gate");
});

test("multi-cycle explanations share the runway text guard and bounded retry", async () => {
  for (const recover of [true, false]) {
    const { request, snapshot } = novemberScenario();
    request.goals[0]!.target_time = "2:10:00";
    let calls = 0;
    const graph = createMasterPlanGraph(
      dependencies({
        contextProvider: { loadSnapshot: async () => snapshot, loadActivities: async () => [] },
        goalAssessmentModel: {
          invoke: async (_input: unknown, retry?: unknown) => {
            calls++;
            const goal = runwayAssessment();
            goal.abc_gates.A.target.time_seconds = 7800;
            goal.abc_gates.B.target.time_seconds = 8000;
            goal.multi_cycle_path =
              retry && recover ? ["Develop the baseline", "Reassess the target"] : ["从上海生成日至比赛日不足12周", "Reassess the target"];
            return goal;
          },
        },
      }),
    );
    const { outcome } = await graph.invoke({ request }, { context });
    assert.equal(calls, 2);
    assert.equal(outcome.decision, recover ? "multi_cycle_required" : "failed_quality_gate");
    if (outcome.decision === "multi_cycle_required") assert.deepEqual(outcome.artifact.cycles, ["Develop the baseline", "Reassess the target"]);
  }
});
