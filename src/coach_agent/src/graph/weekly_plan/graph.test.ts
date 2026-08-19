import assert from "node:assert/strict";
import test from "node:test";
import type { WeeklyPlan } from "../../agents/weekly_plan/schema.js";
import type { CoachAgentConfig } from "../../config/config.js";
import type {
	DailyRecovery,
	WeeklyPlanContext,
} from "../../persistence/index.js";
import { createWeeklyPlanGeneratorGraph } from "./index.js";
import type { WeeklyPlanLlm } from "./llm.js";
import {
	loadWithinTolerance,
	MAX_GENERATION_ATTEMPTS,
	mergeSimulationIntoPlan,
} from "./nodes.js";
import { createWeeklyPlanForSimulation } from "./testFixtures.js";

const config: CoachAgentConfig = {
	models: [],
	agents: [],
	observability: {
		langsmith_enabled: false,
		langsmith_project: "",
		langsmith_endpoint: "",
		langsmith_api_key_env: "",
	},
};

function makeWeeklyPlan(overrides: Partial<WeeklyPlan> = {}): WeeklyPlan {
	const base: WeeklyPlan = {
		schema: "weekly-plan/v1",
		week_name: "2026-08-17_08-23",
		sessions: [
			{
				schema: "plan-session/v1",
				kind: "run",
				date: "2026-08-17",
				session_index: 0,
				summary: "easy run",
				notes_md: null,
				total_distance_m: 8000,
				total_duration_s: 2700,
				estimated_dose: null,
				spec: {
					schema: "run-workout/v1",
					name: "easy run",
					date: "2026-08-17",
					note: null,
					blocks: [
						{
							repeat: 1,
							steps: [
								{
									step_kind: "work",
									duration: { kind: "open", value: null },
									target: { kind: "open", low: null, high: null },
									note: null,
									hr_cap_bpm: null,
								},
							],
						},
					],
				},
			},
			{
				schema: "plan-session/v1",
				kind: "rest",
				date: "2026-08-18",
				session_index: 0,
				summary: "rest day",
				notes_md: null,
				total_distance_m: null,
				total_duration_s: null,
				estimated_dose: null,
				spec: null,
			},
		],
		nutrition: Array.from({ length: 7 }, (_, index) => ({
			schema: "plan-nutrition/v1",
			date: `2026-08-${String(17 + index).padStart(2, "0")}`,
			kcal_target: 2000,
			carbs_g: 250,
			protein_g: 120,
			fat_g: 60,
			water_ml: 2000,
			meals: [],
			notes_md: null,
		})),
		notes_md: null,
		coach_notes: "test plan",
	};
	return { ...base, ...overrides };
}

function fakePlanLlm(plan: WeeklyPlan = makeWeeklyPlan()): WeeklyPlanLlm {
	return {
		async invoke() {
			return plan;
		},
	};
}

function stableRecovery(): DailyRecovery[] {
	return Array.from({ length: 10 }, (_, index) => ({
		date: `2026-08-${String(index + 1).padStart(2, "0")}`,
		rhr: 50,
		hrv: 60,
	}));
}

function deterioratingRecovery(): DailyRecovery[] {
	const history: DailyRecovery[] = [];
	for (let index = 0; index < 10; index += 1) {
		const priorWindow = index < 5;
		history.push({
			date: `2026-08-${String(index + 1).padStart(2, "0")}`,
			rhr: priorWindow ? 50 : 55,
			hrv: priorWindow ? 60 : 52,
		});
	}
	return history;
}

interface SnapshotOverrides {
	fitnessState?: Record<string, unknown>;
	recoveryHistory?: DailyRecovery[];
	latestCompleteWeekDistanceKm?: number | null;
	latestCompleteWeekDose?: number | null;
	recentTrainingWeeks?: Array<Record<string, unknown>>;
	injuries?: Array<{ running_restriction: string }>;
	recoveryWeek?: boolean;
	trainingPosition?: Record<string, unknown>;
}

const BASE_WEEK_KM = 50;
const BASE_WEEK_DOSE = 400;

function defaultRecentWeeks(
	overrides: SnapshotOverrides,
): Array<Record<string, unknown>> {
	const latestKm =
		overrides.latestCompleteWeekDistanceKm === undefined ||
		overrides.latestCompleteWeekDistanceKm === null
			? BASE_WEEK_KM
			: overrides.latestCompleteWeekDistanceKm;
	const latestDose = overrides.latestCompleteWeekDose ?? latestKm * 8;
	const weekStarts = ["2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10"];
	return weekStarts.map((weekStart) => ({
		week_start: weekStart,
		week_end: weekStart,
		complete: true,
		planned: {
			available: false,
			total_run_distance_km: null,
			run_sessions: [],
		},
		actual: {
			total_run_distance_km:
				weekStart === "2026-08-10" ? latestKm : BASE_WEEK_KM,
			total_training_dose:
				weekStart === "2026-08-10" ? latestDose : BASE_WEEK_DOSE,
			run_days: 5,
			longest_run: null,
			quality_stimulus_days: [],
		},
	}));
}

function buildContext(overrides: SnapshotOverrides = {}): WeeklyPlanContext {
	const base = {
		as_of: "2026-08-16",
		plan_start: "2026-08-17",
		week_name: "2026-08-17_08-23",
		lookback: { start_date: "2026-07-18", end_date: "2026-08-14", days: 28 },
		user_profile: {
			age: 47,
			weight_kg: 68,
			threshold_pace_s_per_km: 250,
			threshold_speed_mps: 4,
			lactate_threshold_hr: 170,
			rhr_baseline: 50,
			heart_rate_zones: [],
			pace_zones: [],
		},
		training_position: overrides.trainingPosition ?? {
			phase: null,
			stage: {
				week_index: 0,
				week_start: "2026-08-17",
				phase_name: "build",
				is_recovery_week: overrides.recoveryWeek ?? false,
				target_weekly_km_low: 30,
				target_weekly_km_high: 45,
				key_sessions: [],
			},
		},
		recent_activities: [],
		recent_training_weeks:
			overrides.recentTrainingWeeks ?? defaultRecentWeeks(overrides),
		absorbed_load: {
			complete_weeks_considered: [],
			distance_anchor_km: BASE_WEEK_KM,
			latest_complete_week:
				overrides.latestCompleteWeekDistanceKm === null ||
				overrides.latestCompleteWeekDistanceKm === undefined
					? null
					: {
							week_start: "2026-08-10",
							actual_run_distance_km: overrides.latestCompleteWeekDistanceKm,
							actual_training_dose:
								overrides.latestCompleteWeekDose ??
								overrides.latestCompleteWeekDistanceKm * 8,
						},
		},
		recent_feedback: [],
		fitness_state: overrides.fitnessState ?? {
			as_of_date: "2026-08-16",
			stride_training_load: {
				available: true,
				acute_load: 55,
				chronic_load: 50,
				form: 5,
				load_ratio: 1.0,
			},
			trend: [],
			provenance: { source: "stride", vendor_derived: false },
		},
		injury: overrides.injuries ?? [],
		recovery: {
			latest: null,
			seven_day_average: { rhr: 50, hrv: 60 },
			history: overrides.recoveryHistory ?? stableRecovery(),
			provenance: { source: "raw_health_measurements" },
		},
	};
	return base as unknown as WeeklyPlanContext;
}

const runtimeContext = { userId: "athlete-342", generationId: "generation-1" };

test("weekly plan generator computes a maintain target from the 4-week anchor", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext({ latestCompleteWeekDistanceKm: 50 });
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-1" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	assert.deepEqual(outcome.target_training_load, {
		available: true,
		missing_reason: null,
		load_decision: "maintain",
		training_load_low: 400,
		training_load_high: 432,
		load_ratio_low: 1.1,
		load_ratio_high: 1.14,
		remove_quality_stimulus: false,
		details: {
			last_complete_week: {
				week_start: "2026-08-10",
				distance_km: 50,
				training_load: 400,
			},
			anchor: {
				training_load_avg4w: 400,
				distance_km_avg4w: 50,
			},
			trend: {
				recovery: {
					available: true,
					recent_rhr_avg: 50,
					prior_rhr_avg: 50,
					recent_hrv_avg: 60,
					prior_hrv_avg: 60,
					rhr_rising: false,
					hrv_falling: false,
					deteriorating: false,
					window_days: 5,
					missing_reason: null,
				},
				rhr: {
					"2026-08-07": 50,
					"2026-08-08": 50,
					"2026-08-09": 50,
					"2026-08-10": 50,
					"2026-08-11": null,
					"2026-08-12": null,
					"2026-08-13": null,
					"2026-08-14": null,
					"2026-08-15": null,
					"2026-08-16": null,
				},
				hrv: {
					"2026-08-07": 60,
					"2026-08-08": 60,
					"2026-08-09": 60,
					"2026-08-10": 60,
					"2026-08-11": null,
					"2026-08-12": null,
					"2026-08-13": null,
					"2026-08-14": null,
					"2026-08-15": null,
					"2026-08-16": null,
				},
				seven_day_average: { rhr: 50, hrv: 60 },
				current_load_ratio: 1.0,
				form: 5,
				is_recovery_week: false,
				recovery_week_overridden: false,
				activity_restricted: false,
				recent_high_cost_training: false,
			},
			rationale: [
				"4-week avg training load 400 (4 complete weeks)",
				"4-week avg distance 50 km vs latest complete week 50 km",
				"load_ratio 1.00",
				"recovery trend: rhr 50.0 -> 50.0, hrv 60.0 -> 60.0 (5-day window)",
				"load_ratio 1.00: maintain to +8%",
			],
		},
	});
});

test("weekly plan generator vetoes to 80-90% when recovery deteriorates over 5 days", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext({
					recoveryHistory: deterioratingRecovery(),
					latestCompleteWeekDistanceKm: 50,
				});
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-2" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	const {
		details,
		training_load_low,
		training_load_high,
		load_ratio_low,
		load_ratio_high,
		load_decision,
		remove_quality_stimulus,
	} = outcome.target_training_load;
	assert.deepEqual(
		{
			decision: load_decision,
			low: training_load_low,
			high: training_load_high,
			ratioLow: load_ratio_low,
			ratioHigh: load_ratio_high,
			remove: remove_quality_stimulus,
			deteriorating: details.trend.recovery?.deteriorating,
			rhr_rising: details.trend.recovery?.rhr_rising,
			hrv_falling: details.trend.recovery?.hrv_falling,
		},
		{
			decision: "decrease",
			low: 320,
			high: 360,
			ratioLow: 1,
			ratioHigh: 1.05,
			remove: true,
			deteriorating: true,
			rhr_rising: true,
			hrv_falling: true,
		},
	);
});

test("weekly plan generator deep-cuts a recovery week at or above the anchor", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext({
					recoveryWeek: true,
					latestCompleteWeekDistanceKm: 47,
					recentTrainingWeeks: [
						...Array.from({ length: 3 }, (_, index) => ({
							week_start: `2026-07-${20 + index * 7}`,
							week_end: `2026-07-${20 + index * 7}`,
							complete: true,
							planned: {
								available: false,
								total_run_distance_km: null,
								run_sessions: [],
							},
							actual: {
								total_run_distance_km: 47,
								total_training_dose: 376,
								run_days: 5,
								longest_run: null,
								quality_stimulus_days: [],
							},
						})),
						{
							week_start: "2026-08-10",
							week_end: "2026-08-16",
							complete: true,
							planned: {
								available: false,
								total_run_distance_km: null,
								run_sessions: [],
							},
							actual: {
								total_run_distance_km: 47,
								total_training_dose: 376,
								run_days: 5,
								longest_run: null,
								quality_stimulus_days: [],
							},
						},
					],
				});
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-3" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	const target = outcome.target_training_load;
	assert.equal(target.details.trend.is_recovery_week, true);
	assert.equal(target.details.trend.recovery_week_overridden, false);
	assert.equal(target.load_decision, "recover");
	assert.equal(target.training_load_low, 263.2);
	assert.equal(target.training_load_high, 300.8);
	assert.equal(target.remove_quality_stimulus, true);
});

test("weekly plan generator treats an undelivered peak week as its own recovery", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext({
					recoveryWeek: true,
					latestCompleteWeekDistanceKm: 66,
					latestCompleteWeekDose: 369,
					recentTrainingWeeks: [
						...Array.from({ length: 3 }, (_, index) => ({
							week_start: `2026-07-${20 + index * 7}`,
							week_end: `2026-07-${20 + index * 7}`,
							complete: true,
							planned: {
								available: false,
								total_run_distance_km: null,
								run_sessions: [],
							},
							actual: {
								total_run_distance_km: 66,
								total_training_dose: 369,
								run_days: 5,
								longest_run: null,
								quality_stimulus_days: [],
							},
						})),
						{
							week_start: "2026-08-10",
							week_end: "2026-08-16",
							complete: true,
							planned: {
								available: true,
								distance_coverage: "complete",
								total_run_distance_km: 80,
								run_sessions: [],
							},
							actual: {
								total_run_distance_km: 66,
								total_training_dose: 369,
								run_days: 5,
								longest_run: null,
								quality_stimulus_days: [],
							},
						},
					],
				});
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-4" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	const target = outcome.target_training_load;
	assert.equal(target.details.trend.is_recovery_week, true);
	assert.equal(target.details.trend.recovery_week_overridden, true);
	assert.equal(target.load_decision, "maintain");
	assert.equal(target.training_load_low, 369);
	assert.equal(target.training_load_high, 398.52);
	assert.equal(target.remove_quality_stimulus, false);
});

test("weekly plan generator maps context-provider errors to a typed failure", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				throw new Error("mysql unavailable");
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-5" } },
		{ context: runtimeContext },
	);

	assert.deepEqual(outcome, {
		decision: "infrastructure_failure",
		request_id: "request-5",
		generation_id: "generation-1",
		reason: "context_snapshot_unavailable",
	});
});

test("weekly plan generator rejects unknown request fields", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext();
			},
		},
		fakePlanLlm(),
	);
	await assert.rejects(
		() =>
			graph.invoke(
				{ request: { request_id: "request-6", extra: 1 } } as never,
				{ context: runtimeContext },
			),
		/Unrecognized key/,
	);
});

const CANONICAL_PHASES = [
	"base",
	"build",
	"speed",
	"marathon",
	"taper",
	"recovery",
] as const;

for (const phase of CANONICAL_PHASES) {
	test(`weekly plan generator routes the ${phase} phase from stage.phase_name`, async () => {
		const graph = createWeeklyPlanGeneratorGraph(
			config,
			{
				async loadSnapshot() {
					return buildContext({
						trainingPosition: {
							phase: { name: "marathon" },
							stage: {
								week_index: 0,
								week_start: "2026-08-17",
								phase_name: phase,
								is_recovery_week: false,
								target_weekly_km_low: 30,
								target_weekly_km_high: 45,
								key_sessions: [],
							},
						},
					});
				},
			},
			fakePlanLlm(),
		);
		const { outcome } = await graph.invoke(
			{ request: { request_id: `request-${phase}` } },
			{ context: runtimeContext },
		);

		assert.equal(outcome.decision, "completed");
		assert.equal(outcome.phase, phase);
	});
}

test("weekly plan generator falls back to phase.name when stage.phase_name is missing", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext({
					trainingPosition: {
						phase: { name: "taper" },
						stage: {
							week_index: 0,
							week_start: "2026-08-17",
							phase_name: null,
							is_recovery_week: false,
							target_weekly_km_low: 30,
							target_weekly_km_high: 45,
							key_sessions: [],
						},
					},
				});
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-fallback" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	assert.equal(outcome.phase, "taper");
});

test("weekly plan generator prefers stage.phase_name over phase.name", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext({
					trainingPosition: {
						phase: { name: "base" },
						stage: {
							week_index: 0,
							week_start: "2026-08-17",
							phase_name: "recovery",
							is_recovery_week: true,
							target_weekly_km_low: 30,
							target_weekly_km_high: 45,
							key_sessions: [],
						},
					},
				});
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-priority" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	assert.equal(outcome.phase, "recovery");
});

test("weekly plan generator fails with phase_unresolvable when no canonical phase exists", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext({
					trainingPosition: {
						phase: { name: "自由训练期" },
						stage: {
							week_index: 0,
							week_start: "2026-08-17",
							phase_name: null,
							is_recovery_week: false,
							target_weekly_km_low: 30,
							target_weekly_km_high: 45,
							key_sessions: [],
						},
					},
				});
			},
		},
		fakePlanLlm(),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-unresolvable" } },
		{ context: runtimeContext },
	);

	assert.deepEqual(outcome, {
		decision: "quality_failure",
		request_id: "request-unresolvable",
		generation_id: "generation-1",
		reason: "phase_unresolvable",
	});
});

test("weekly plan generator includes the generated plan in the completed outcome", async () => {
	const plan = makeWeeklyPlan();
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext();
			},
		},
		fakePlanLlm(plan),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-generated" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	assert.equal(outcome.phase, "build");
	assert.deepEqual(outcome.weekly_plan, plan);
});

test("weekly plan generator fails with generation_failed when the plan LLM errors", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext();
			},
		},
		{
			async invoke() {
				throw new Error("model unavailable");
			},
		},
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-llm-error" } },
		{ context: runtimeContext },
	);

	assert.deepEqual(outcome, {
		decision: "quality_failure",
		request_id: "request-llm-error",
		generation_id: "generation-1",
		reason: "generation_failed",
	});
});

function scaledSimulationPlan(factor: number): WeeklyPlan {
	const base = createWeeklyPlanForSimulation();
	return {
		...base,
		sessions: base.sessions.map((session) => {
			const spec = session.spec as unknown as {
				schema: string;
				name: string;
				date: string;
				note: string | null;
				blocks: Array<{
					repeat: number;
					steps: Array<{
						step_kind: string;
						duration: { kind: string; value: number | null };
						target: unknown;
						note: string | null;
						hr_cap_bpm: number | null;
					}>;
				}>;
			};
			return {
				...session,
				total_distance_m: Math.round((session.total_distance_m ?? 0) * factor),
				spec: {
					...spec,
					blocks: spec.blocks.map((block) => ({
						...block,
						steps: block.steps.map((step) => ({
							...step,
							duration:
								step.duration.kind === "distance_m"
									? {
											kind: "distance_m",
											value: Math.round((step.duration.value ?? 0) * factor),
										}
									: step.duration,
						})),
					})),
				} as WeeklyPlan["sessions"][number]["spec"],
			};
		}),
	} as WeeklyPlan;
}

function targetFromContext(overrides: SnapshotOverrides = {}) {
	return buildContext({
		...overrides,
		latestCompleteWeekDistanceKm: overrides.latestCompleteWeekDistanceKm ?? 12,
		latestCompleteWeekDose: overrides.latestCompleteWeekDose ?? 96,
		recentTrainingWeeks: Array.from({ length: 4 }, (_, index) => ({
			week_start: `2026-07-${20 + index * 7}`,
			week_end: `2026-07-${20 + index * 7}`,
			complete: true,
			planned: {
				available: false,
				total_run_distance_km: null,
				run_sessions: [],
			},
			actual: {
				total_run_distance_km: 12,
				total_training_dose: 96,
				run_days: 5,
				longest_run: null,
				quality_stimulus_days: [],
			},
		})),
	});
}

test("loadWithinTolerance accepts total dose inside the ±10% target band", () => {
	const simulation = {
		available: true,
		total_dose: 440,
	} as unknown as NonNullable<Parameters<typeof loadWithinTolerance>[0]>;
	const target = {
		training_load_low: 400,
		training_load_high: 432,
	} as unknown as NonNullable<Parameters<typeof loadWithinTolerance>[1]>;
	assert.equal(loadWithinTolerance(simulation, target), true);
	assert.equal(
		loadWithinTolerance({ ...simulation, total_dose: 360 }, target),
		true,
	);
	assert.equal(
		loadWithinTolerance({ ...simulation, total_dose: 475.2 }, target),
		true,
	);
});

test("loadWithinTolerance rejects total dose outside the ±10% target band", () => {
	const simulation = {
		available: true,
		total_dose: 359,
	} as unknown as NonNullable<Parameters<typeof loadWithinTolerance>[0]>;
	const target = {
		training_load_low: 400,
		training_load_high: 432,
	} as unknown as NonNullable<Parameters<typeof loadWithinTolerance>[1]>;
	assert.equal(loadWithinTolerance(simulation, target), false);
	assert.equal(
		loadWithinTolerance({ ...simulation, total_dose: 476 }, target),
		false,
	);
});

test("loadWithinTolerance is undecidable without simulation or target load", () => {
	const simulation = {
		available: false,
		total_dose: null,
	} as unknown as NonNullable<Parameters<typeof loadWithinTolerance>[0]>;
	const target = {
		training_load_low: 400,
		training_load_high: 432,
	} as unknown as NonNullable<Parameters<typeof loadWithinTolerance>[1]>;
	assert.equal(loadWithinTolerance(simulation, target), null);
	assert.equal(
		loadWithinTolerance(
			{ ...simulation, available: true },
			{ ...target, training_load_low: null },
		),
		null,
	);
	assert.equal(loadWithinTolerance(undefined, target), null);
});

test("mergeSimulationIntoPlan back-fills per-session estimated doses", () => {
	const plan = makeWeeklyPlan();
	const simulation = {
		sessions: [
			{ session_index: 0, estimated_dose: 52.6 },
			{ session_index: 1, estimated_dose: 44.0 },
		],
	} as unknown as NonNullable<Parameters<typeof mergeSimulationIntoPlan>[1]>;
	const merged = mergeSimulationIntoPlan(plan, simulation);
	assert.equal(merged.sessions[0]?.estimated_dose, 52.6);
	assert.equal(merged.sessions[1]?.estimated_dose, 44);
});

test("weekly plan generator accepts the plan when total dose stays within 10% of the target", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return targetFromContext();
			},
		},
		fakePlanLlm(createWeeklyPlanForSimulation()),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-in-band" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	if (outcome.decision !== "completed") {
		throw new Error("unreachable");
	}
	assert.equal(outcome.generation_attempts, 1);
	assert.equal(outcome.simulation.available, true);
	assert.equal(
		loadWithinTolerance(outcome.simulation, outcome.target_training_load),
		true,
	);
	assert.ok(
		outcome.weekly_plan.sessions.some(
			(session) => session.estimated_dose !== null,
		),
	);
});

test("weekly plan generator bounces the plan back to the phase node when total dose misses the target", async () => {
	let invocations = 0;
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext();
			},
		},
		{
			async invoke(input) {
				invocations += 1;
				if (invocations === 1) {
					assert.equal(input.previousSimulation, null);
					return createWeeklyPlanForSimulation();
				}
				assert.equal(input.previousSimulation?.attempt, 1);
				return scaledSimulationPlan(4);
			},
		},
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-bounced" } },
		{ context: runtimeContext },
	);

	assert.equal(outcome.decision, "completed");
	if (outcome.decision !== "completed") {
		throw new Error("unreachable");
	}
	assert.equal(outcome.phase, "build");
	assert.equal(outcome.generation_attempts, 2);
	assert.equal(
		loadWithinTolerance(outcome.simulation, outcome.target_training_load),
		true,
	);
});

test("weekly plan generator fails with load_mismatch_unresolved after exhausting attempts", async () => {
	const graph = createWeeklyPlanGeneratorGraph(
		config,
		{
			async loadSnapshot() {
				return buildContext();
			},
		},
		fakePlanLlm(createWeeklyPlanForSimulation()),
	);
	const { outcome } = await graph.invoke(
		{ request: { request_id: "request-mismatch" } },
		{ context: runtimeContext },
	);

	assert.deepEqual(outcome, {
		decision: "quality_failure",
		request_id: "request-mismatch",
		generation_id: "generation-1",
		reason: "load_mismatch_unresolved",
	});
	assert.equal(MAX_GENERATION_ATTEMPTS, 3);
});
