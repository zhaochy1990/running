import assert from "node:assert/strict";
import test from "node:test";
import {
	AthleteAssessmentSchema,
	authoritativeGoalLevel,
	ContextSnapshotSchema,
	createMasterPlanGraph,
	deriveAssessmentFacts,
	GoalAssessmentSchema,
	type MasterPlanGraphContext,
	MasterPlanGraphRequest,
	validateAthleteAssessmentRanges,
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

function validAthleteAssessment() {
	return {
		schema_version: 2 as const,
		readiness: "ready" as const,
		summary: "Recent training supports continued structured preparation.",
		capability_confidence: "high" as const,
		current_phase: null,
		continuity: "continuous" as const,
		recommended_entry_phase: "build" as const,
		safe_training_ranges: {
			starting_weekly_distance_km: { low: 62, high: 70 },
			weekly_distance_km: { low: 62, high: 82 },
			runs_per_week: { low: 4, high: 6 },
			long_run_km: { low: 20, high: 30 },
			quality_sessions_per_week: { low: 1, high: 2 },
		},
		material_conclusions: [
			{
				claim: "volume_baseline_established" as const,
				explanation:
					"The recent weekly baseline supports structured preparation.",
				fact_ids: ["volume.recent_weekly_km"],
			},
		],
		limiting_factors: [],
		assumptions_to_validate: [],
		gaps: [],
	};
}

function validGoalAssessment() {
	return {
		schema_version: 2 as const,
		level: "aggressive_but_plausible" as const,
		summary:
			"The confirmed 2:50 goal is plausible only through explicit gates.",
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
		},
		assessmentModel: {
			async invoke() {
				return validAthleteAssessment();
			},
		},
		goalAssessmentModel: {
			async invoke() {
				return validGoalAssessment();
			},
		},
		strategyModel: {
			async invoke({
				archetype,
			}: {
				archetype: "conservative" | "balanced" | "aggressive_gated";
			}) {
				return createTestStrategyCandidate(archetype);
			},
		},
		judgmentModel: {
			async invoke({
				judge,
				candidate,
			}: {
				judge: "performance_path" | "safety_load" | "constraint_feasibility";
				candidate: ReturnType<typeof createTestStrategyCandidate>;
			}) {
				return createTestJudgments(candidate.candidate_id).find(
					(item) => item.judge === judge,
				)!;
			},
		},
		reviewModel: {
			async invoke({
				reviewerType,
			}: {
				reviewerType:
					| "periodization"
					| "load_progression"
					| "constraint_grounding";
			}) {
				return createTestReviewReport(reviewerType);
			},
		},
		skeletonModel: {
			async invoke() {
				return createTestMasterPlan();
			},
		},
		...overrides,
	};
}

test("derives deterministic assessment facts from worked literals and passes assessments to skeleton", async () => {
	const skeletonInputs: unknown[] = [];
	const goalInputs: unknown[] = [];
	const graph = createMasterPlanGraph(
		dependencies({
			goalAssessmentModel: {
				async invoke(input: unknown) {
					goalInputs.push(input);
					return validGoalAssessment();
				},
			},
			skeletonModel: {
				async invoke(input: unknown) {
					skeletonInputs.push(input);
					return createTestMasterPlan();
				},
			},
		}),
	);

	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);

	assert.equal(outcome.decision, "completed");
	if (outcome.decision !== "completed") assert.fail("expected completed");
	const values = Object.fromEntries(
		outcome.artifact.facts.facts.map((fact) => [fact.fact_id, fact.value]),
	);
	assert.equal(values["volume.stable_weekly_km"], 64);
	assert.equal(values["volume.recent_weekly_km"], 70);
	assert.equal(values["frequency.recent_run_days_per_week"], 5.5);
	assert.equal(values["tolerance.long_run_km"], 25);
	assert.equal(values["tolerance.quality_sessions_per_week"], 1.5);
	assert.equal(values["history.peak_weekly_km"], 92);
	assert.equal(values["history.longest_run_km"], 32);
	assert.equal(values["history.longest_road_run_km"], 32);
	assert.equal(values["history.max_gap_days"], 18);
	assert.equal(values["load.current_ctl"], 68);
	assert.equal(values["load.current_atl"], 74);
	assert.equal(values["load.current_form"], -6);
	assert.equal(values["race.a.weeks_to_race"], 9.86);
	assert.equal(values["goal.a.matching_pb_seconds"], 10631);
	assert.equal(values["goal.a.improvement_pct"], 4.05);
	assert.equal(values["coverage.ratio"], 0.75);
	assert.equal(values["continuity.days_since_last_run"], 1);
	assert.equal(values["continuity.current_phase"], "none");
	assert.deepEqual(
		(goalInputs[0] as { athleteAssessment: unknown }).athleteAssessment,
		outcome.artifact.athlete_assessment,
	);
	const input = skeletonInputs[0] as {
		facts: unknown;
		athleteAssessment: unknown;
		goalAssessment: unknown;
	};
	assert.deepEqual(input.facts, outcome.artifact.facts);
	assert.deepEqual(
		input.athleteAssessment,
		outcome.artifact.athlete_assessment,
	);
	assert.deepEqual(input.goalAssessment, outcome.artifact.goal_assessment);
});

test("athlete assessment rejects goal-specific conclusions", () => {
	assert.throws(() =>
		AthleteAssessmentSchema.parse({
			...validAthleteAssessment(),
			material_conclusions: [
				{
					claim: "goal_runway_limited",
					explanation: "Goal runway is limited",
					fact_ids: ["race.a.weeks_to_race"],
				},
			],
		}),
	);
});

test("athlete assessment rejects goal facts in capability notes", () => {
	assert.throws(() => {
		const assessment = AthleteAssessmentSchema.parse({
			...validAthleteAssessment(),
			limiting_factors: [
				{
					description: "The goal runway is short",
					fact_ids: ["race.a.weeks_to_race"],
				},
			],
		});
		validateAthleteAssessmentRanges(
			assessment,
			deriveAssessmentFacts(
				ContextSnapshotSchema.parse(createAssessmentSnapshot()),
				MasterPlanGraphRequest.parse(createTestRequest()),
			),
			MasterPlanGraphRequest.parse(createTestRequest()),
		);
	});
});

test("limited athlete capability makes an otherwise supported goal conditional", () => {
	const snapshot = createAssessmentSnapshot();
	snapshot.continuity.days_since_last_run = 30;
	const facts = deriveAssessmentFacts(
		ContextSnapshotSchema.parse(snapshot),
		MasterPlanGraphRequest.parse(createTestRequest()),
	);
	const athlete = AthleteAssessmentSchema.parse({
		...validAthleteAssessment(),
		readiness: "limited",
		continuity: "returning",
		recommended_entry_phase: "return_to_run",
	});
	assert.equal(authoritativeGoalLevel(facts, athlete), "conditional");
});

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

test("rejects an assessment citation whose fact id does not exist", async () => {
	const assessment = AthleteAssessmentSchema.parse(validAthleteAssessment());
	assessment.material_conclusions[0]!.fact_ids[0] = "invented.fact";
	const graph = createMasterPlanGraph(
		dependencies({
			assessmentModel: {
				async invoke() {
					return assessment;
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "failed_quality_gate");
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
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
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
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
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
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "failed_quality_gate");
});

test("rejects supportive load claims when deterministic form is negative", async () => {
	const assessment = AthleteAssessmentSchema.parse(validAthleteAssessment());
	assessment.material_conclusions = [
		{
			claim: "load_state_supportive",
			explanation: "Load state supports progression",
			fact_ids: ["load.current_form"],
		},
	];
	const graph = createMasterPlanGraph(
		dependencies({
			assessmentModel: {
				async invoke() {
					return assessment;
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "failed_quality_gate");
});

test("canonicalizes free-form explanations from controlled claims", async () => {
	const assessment = AthleteAssessmentSchema.parse(validAthleteAssessment());
	assessment.material_conclusions[0]!.explanation =
		"The athlete has no usable volume baseline.";
	const graph = createMasterPlanGraph(
		dependencies({
			assessmentModel: {
				async invoke() {
					return assessment;
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "completed");
	if (outcome.decision !== "completed") assert.fail("expected completed");
	assert.equal(
		outcome.artifact.athlete_assessment.material_conclusions[0]?.explanation,
		"Recent volume establishes a usable training baseline.",
	);
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
			},
			goalAssessmentModel: {
				async invoke() {
					goalCalls += 1;
					return validGoalAssessment();
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "needs_baseline");
	assert.equal(goalCalls, 0);
});

test("assessment facts exclude the current incomplete Shanghai week", async () => {
	const snapshot = createAssessmentSnapshot();
	snapshot.recent_history.weeks.push({
		...snapshot.recent_history.weeks.at(-1)!,
		week_start: "2026-08-10",
		distance_km: 1,
		run_count: 1,
		run_day_count: 1,
		long_run_km: 1,
	});
	const graph = createMasterPlanGraph(
		dependencies({
			contextProvider: {
				async loadSnapshot() {
					return snapshot;
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "completed");
	if (outcome.decision !== "completed") assert.fail("expected completed");
	const recent = outcome.artifact.facts.facts.find(
		(fact) => fact.fact_id === "volume.recent_weekly_km",
	);
	assert.equal(recent?.value, 70);
});

test("assessment facts include complete zero-run weeks", async () => {
	const snapshot = createAssessmentSnapshot();
	snapshot.recent_history.weeks.at(-1)!.distance_km = 0;
	snapshot.recent_history.weeks.at(-1)!.run_count = 0;
	snapshot.recent_history.weeks.at(-1)!.run_day_count = 0;
	snapshot.recent_history.weeks.at(-1)!.long_run_km = 0;
	const facts = deriveAssessmentFacts(
		ContextSnapshotSchema.parse(snapshot),
		MasterPlanGraphRequest.parse(createTestRequest()),
	);
	assert.equal(
		facts.facts.find(
			(fact) => fact.fact_id === "frequency.recent_run_days_per_week",
		)?.value,
		5.5,
	);
});

test("zero recent running baseline stops before assessment models", async () => {
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
			},
			assessmentModel: {
				async invoke() {
					modelCalls += 1;
					return validAthleteAssessment();
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "needs_baseline");
	assert.equal(modelCalls, 0);
});

test("zero quality-session history cannot authorize quality sessions", async () => {
	const snapshot = createAssessmentSnapshot();
	for (const week of snapshot.recent_history.weeks.slice(-4))
		week.speed_session_count = 0;
	const assessment = AthleteAssessmentSchema.parse(validAthleteAssessment());
	assessment.safe_training_ranges.quality_sessions_per_week = {
		low: 0,
		high: 1,
	};
	const graph = createMasterPlanGraph(
		dependencies({
			contextProvider: {
				async loadSnapshot() {
					return snapshot;
				},
			},
			assessmentModel: {
				async invoke() {
					return assessment;
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "failed_quality_gate");
});

test("zero quality-session history cannot support an established-tolerance claim", async () => {
	const snapshot = createAssessmentSnapshot();
	for (const week of snapshot.recent_history.weeks.slice(-4))
		week.speed_session_count = 0;
	const assessment = AthleteAssessmentSchema.parse(validAthleteAssessment());
	assessment.safe_training_ranges.quality_sessions_per_week = {
		low: 0,
		high: 0,
	};
	assessment.material_conclusions = [
		{
			claim: "quality_tolerance_established",
			explanation: "Quality tolerance is established",
			fact_ids: ["tolerance.quality_sessions_per_week"],
		},
	];
	const graph = createMasterPlanGraph(
		dependencies({
			contextProvider: {
				async loadSnapshot() {
					return snapshot;
				},
			},
			assessmentModel: {
				async invoke() {
					return assessment;
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "failed_quality_gate");
});

test("missing road-run evidence cannot authorize a positive long-run range", async () => {
	const snapshot = ContextSnapshotSchema.parse({
		...createAssessmentSnapshot(),
		macro_history: {
			...createAssessmentSnapshot().macro_history,
			longest_road_run_km: null,
		},
	});
	const graph = createMasterPlanGraph(
		dependencies({
			contextProvider: {
				async loadSnapshot() {
					return snapshot;
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "failed_quality_gate");
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

test("rejects a model-declared multi-cycle stop that contradicts deterministic facts", async () => {
	const goal = {
		...validGoalAssessment(),
		level: "multi_cycle_required" as const,
		multi_cycle_path: ["Build baseline", "Reassess target"],
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
	const { outcome } = await graph.invoke(
		{ request: createTestRequest() },
		{ context },
	);
	assert.equal(outcome.decision, "failed_quality_gate");
});

test("explicit current acute restrictions stop before either assessment model", async () => {
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
			assessmentModel: {
				async invoke() {
					modelCalls += 1;
					return validAthleteAssessment();
				},
			},
		}),
	);
	const { outcome } = await graph.invoke(
		{ request: injuredRequest },
		{ context },
	);
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
