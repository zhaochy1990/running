import assert from "node:assert/strict";
import test from "node:test";
import type { Activity } from "./dataStore.js";
import { MySqlWeeklyPlanContextProvider } from "./weeklyPlanContextProvider.js";

const activity: Activity = {
	userId: "athlete",
	labelId: "run-1",
	name: "Threshold run",
	sportName: "Run",
	date: new Date("2026-08-13T16:30:00Z"),
	distanceM: 10000,
	durationS: 3000,
	avgPaceSKm: 300,
	adjustedPace: null,
	bestKmPace: null,
	maxPace: null,
	avgHr: 160,
	maxHr: 178,
	avgCadence: null,
	maxCadence: null,
	avgPower: null,
	maxPower: null,
	avgStepLenCm: null,
	ascentM: null,
	descentM: null,
	caloriesKcal: null,
	aerobicEffect: null,
	anaerobicEffect: null,
	trainingLoad: 999,
	strideDose: 72,
	vo2max: null,
	temperature: null,
	humidity: null,
	feelsLike: null,
	windSpeed: null,
	sportNote: "controlled",
	sport: "run_outdoor",
	trainKind: "threshold",
	feel: "good",
	verticalOscillationMm: null,
	groundContactTimeMs: null,
	verticalRatioPct: null,
	pauses: null,
	provider: "coros",
};

function providerUsingMySqlFeedback(
	store: ConstructorParameters<typeof MySqlWeeklyPlanContextProvider>[0],
): MySqlWeeklyPlanContextProvider {
	return new MySqlWeeklyPlanContextProvider(store, {
		weeklyFeedbackCutoverComplete: true,
	});
}

test("weekly context combines all weekly planning evidence", async () => {
	const ranges: Array<[string, string, string]> = [];
	const provider = providerUsingMySqlFeedback({
		async getMasterPlanMetadataForDate() {
			return {
				planId: "plan-1",
				revision: 2,
				status: "active",
				content: {
					phases: [
						{
							name: "提升期",
							start_date: "2026-08-01",
							end_date: "2026-08-31",
							focus: "threshold",
						},
					],
					weeks: [
						{
							week_index: 3,
							week_start: "2026-08-10",
							phase_name: "提升期",
							is_recovery_week: false,
							target_weekly_km_low: 55,
							target_weekly_km_high: 60,
							key_sessions: [{ type: "threshold" }],
						},
					],
					milestones: [
						{
							type: "test_run",
							date: "2026-08-23",
							target: "2×20 minutes at threshold with stable effort",
						},
						{
							type: "race",
							date: "2026-10-18",
							target: "race outside the current phase",
						},
					],
				},
			};
		},
		async getWeeklyPlan(_userId, weekName) {
			return weekName === "2026-08-10_08-16"
				? {
						sessions: [
							{
								kind: "run",
								date: "2026-08-12",
								summary: "5×1 km intervals",
								total_distance_m: 12000,
							},
							{
								kind: "run",
								date: "2026-08-14",
								summary: "Flexible recovery run",
								total_distance_m: null,
							},
						],
					}
				: null;
		},
		async getActivitiesByDateRange(userId, start, end) {
			ranges.push([userId, start, end]);
			return [
				activity,
				{
					...activity,
					labelId: "run-2",
					name: "Interval cooldown",
					distanceM: 2000,
					durationS: 900,
					strideDose: 15,
					trainKind: "vo2max",
				},
			];
		},
		async getWeeklyFeedbackByDateRange(userId, start, end) {
			ranges.push([userId, start, end]);
			return [
				{
					weekStart: "2026-08-03",
					contentMd: "legs recovered",
					updatedAt: new Date("2026-08-10T01:00:00Z"),
				},
			];
		},
		async getDailyTrainingLoadByDateRange() {
			return [
				{
					date: "2026-08-14",
					trainingDose: 72,
					acuteLoad: 66,
					chronicLoad: 60,
					form: -6,
					loadRatio: 1.1,
					readinessGate: "red",
					coverageStatus: "complete",
				},
			];
		},
		async getDailyRecoveryByDateRange() {
			return [
				{ date: "2026-08-01", rhr: 40, hrv: 100 },
				{ date: "2026-08-13", rhr: 50, hrv: 60 },
				{ date: "2026-08-14", rhr: 52, hrv: 56 },
			];
		},
		async getUserInjuries() {
			return [
				{
					description: "left Achilles",
					recoveryStatus: "recovering",
					runningRestriction: "easy_only",
				},
			];
		},
		async getLatestRunningCalibration() {
			return {
				asOfDate: "2026-08-01",
				thresholdHr: 170,
				thresholdSpeedMps: 4,
				rhrBaseline: 48,
				thresholdHrConfidence: "high",
				thresholdSpeedConfidence: "medium",
				heartRateZones: [{ name: "Z2", minBpm: 130, maxBpm: 145 }],
				paceZones: [{ name: "Z2", minPaceSPerKm: 330, maxPaceSPerKm: 390 }],
			};
		},
	});

	const snapshot = await provider.loadSnapshot("athlete", "2026-08-15");

	assert.equal(snapshot.as_of, "2026-08-15");
	assert.equal(snapshot.plan_start, "2026-08-17");
	assert.equal(snapshot.week_folder, "2026-08-17_08-23");
	assert.deepEqual(snapshot.lookback, {
		start_date: "2026-07-19",
		end_date: "2026-08-15",
		days: 28,
	});
	assert.equal(snapshot.training_position.phase?.name, "提升期");
	assert.deepEqual(snapshot.training_position.phase?.milestones, [
		{
			type: "test_run",
			date: "2026-08-23",
			target: "2×20 minutes at threshold with stable effort",
			completed_actual: null,
		},
	]);
	assert.equal(snapshot.training_position.stage, null);
	assert.deepEqual(snapshot.absorbed_load, {
		complete_weeks_considered: [
			{
				week_start: "2026-07-20",
				actual_run_distance_km: 0,
				actual_training_dose: 0,
			},
			{
				week_start: "2026-07-27",
				actual_run_distance_km: 0,
				actual_training_dose: 0,
			},
			{
				week_start: "2026-08-03",
				actual_run_distance_km: 0,
				actual_training_dose: 0,
			},
		],
		distance_anchor_km: 0,
		latest_complete_week: {
			week_start: "2026-08-03",
			actual_run_distance_km: 0,
			actual_training_dose: 0,
		},
	});
	assert.deepEqual(snapshot.recent_training_weeks.at(-1), {
		week_start: "2026-08-10",
		week_end: "2026-08-16",
		complete: false,
		planned: {
			available: true,
			distance_coverage: "partial",
			total_run_distance_km: null,
			run_sessions: [
				{
					date: "2026-08-12",
					summary: "5×1 km intervals",
					distance_km: 12,
				},
				{
					date: "2026-08-14",
					summary: "Flexible recovery run",
					distance_km: null,
				},
			],
		},
		actual: {
			total_run_distance_km: 12,
			total_training_dose: 87,
			run_days: 1,
			longest_run: {
				date: "2026-08-14",
				distance_km: 12,
			},
			quality_stimulus_days: [
				{
					date: "2026-08-14",
					training_types: ["threshold", "vo2max"],
					names: ["Threshold run", "Interval cooldown"],
					notes: ["controlled"],
					total_distance_km: 12,
				},
			],
		},
	});
	assert.equal(snapshot.recent_activities[0]?.date, "2026-08-14");
	assert.equal(snapshot.recent_activities[0]?.training_dose, 72);
	const recentActivity = snapshot.recent_activities[0];
	assert.ok(recentActivity);
	assert.equal("training_load" in recentActivity, false);
	assert.equal(snapshot.recent_feedback[0]?.content_md, "legs recovered");
	assert.deepEqual(snapshot.fitness_state.provenance, {
		source: "stride",
		vendor_derived: false,
	});
	assert.equal(
		(snapshot.fitness_state.stride_training_load as Record<string, unknown>)
			.load_ratio,
		1.1,
	);
	assert.equal("readiness_gate" in snapshot.fitness_state, false);
	assert.deepEqual(
		(snapshot.injury_and_recovery.recovery as Record<string, unknown>)
			.seven_day_average,
		{ rhr: 51, hrv: 58 },
	);
	assert.equal(snapshot.running_calibration?.lactate_threshold_hr, 170);
	assert.equal(snapshot.running_calibration?.threshold_pace_s_per_km, 250);
	assert.deepEqual(ranges, [
		["athlete", "2026-07-19", "2026-08-15"],
		["athlete", "2026-07-13", "2026-08-15"],
	]);
});

test("weekly context anchors distance to completed-week median", async () => {
	const provider = providerUsingMySqlFeedback({
		async getMasterPlanMetadataForDate() {
			return null;
		},
		async getWeeklyPlan() {
			return null;
		},
		async getActivitiesByDateRange() {
			return [
				{
					...activity,
					labelId: "week-1",
					date: new Date("2026-07-21T04:00:00Z"),
					distanceM: 40_000,
					strideDose: 40,
				},
				{
					...activity,
					labelId: "week-2",
					date: new Date("2026-07-28T04:00:00Z"),
					distanceM: 80_000,
					strideDose: 80,
				},
				{
					...activity,
					labelId: "week-3",
					date: new Date("2026-08-04T04:00:00Z"),
					distanceM: 60_000,
					strideDose: 60,
				},
				{
					...activity,
					labelId: "partial-week",
					date: new Date("2026-08-11T04:00:00Z"),
					distanceM: 200_000,
					strideDose: 200,
				},
			];
		},
		async getWeeklyFeedbackByDateRange() {
			return [];
		},
		async getDailyTrainingLoadByDateRange() {
			return [];
		},
		async getDailyRecoveryByDateRange() {
			return [];
		},
		async getUserInjuries() {
			return [];
		},
		async getLatestRunningCalibration() {
			return null;
		},
	});

	const snapshot = await provider.loadSnapshot("athlete", "2026-08-15");

	assert.equal(snapshot.absorbed_load.distance_anchor_km, 60);
	assert.deepEqual(snapshot.absorbed_load.latest_complete_week, {
		week_start: "2026-08-03",
		actual_run_distance_km: 60,
		actual_training_dose: 60,
	});
	assert.equal(snapshot.recent_training_weeks.at(-1)?.complete, false);
});

test("weekly context keeps a Monday as the planning start", async () => {
	const activityRanges: Array<[string, string]> = [];
	const provider = new MySqlWeeklyPlanContextProvider({
		async getMasterPlanMetadataForDate() {
			return null;
		},
		async getWeeklyPlan() {
			return null;
		},
		async getActivitiesByDateRange(_userId, start, end) {
			activityRanges.push([start, end]);
			return [
				{
					...activity,
					labelId: "earliest-week-monday",
					date: new Date("2026-07-20T04:00:00Z"),
				},
			];
		},
		async getWeeklyFeedbackByDateRange() {
			return [];
		},
		async getDailyTrainingLoadByDateRange() {
			return [];
		},
		async getDailyRecoveryByDateRange() {
			return [];
		},
		async getUserInjuries() {
			return [];
		},
		async getLatestRunningCalibration() {
			return null;
		},
	});

	const snapshot = await provider.loadSnapshot("athlete", "2026-08-17");
	assert.equal(snapshot.plan_start, "2026-08-17");
	assert.deepEqual(activityRanges, [["2026-07-20", "2026-08-17"]]);
	assert.equal(snapshot.recent_training_weeks[0]?.actual.run_days, 1);
	assert.equal(snapshot.recent_activities.length, 0);
});

test("weekly context reports unavailable STRIDE load without fallback", async () => {
	const provider = new MySqlWeeklyPlanContextProvider({
		async getMasterPlanMetadataForDate() {
			return null;
		},
		async getWeeklyPlan() {
			return null;
		},
		async getActivitiesByDateRange() {
			return [];
		},
		async getWeeklyFeedbackByDateRange() {
			return [];
		},
		async getDailyTrainingLoadByDateRange() {
			return [];
		},
		async getDailyRecoveryByDateRange() {
			return [];
		},
		async getUserInjuries() {
			return [];
		},
		async getLatestRunningCalibration() {
			return null;
		},
	});

	const snapshot = await provider.loadSnapshot(
		"athlete",
		"2026-08-14T00:00:00Z",
	);
	assert.deepEqual(snapshot.fitness_state.stride_training_load, {
		available: false,
		missing_reason: "stride_load_not_computed",
	});
	assert.equal(snapshot.running_calibration, null);
});

test("weekly context treats null PMC values as not computed", async () => {
	const provider = new MySqlWeeklyPlanContextProvider({
		async getMasterPlanMetadataForDate() {
			return null;
		},
		async getWeeklyPlan() {
			return null;
		},
		async getActivitiesByDateRange() {
			return [];
		},
		async getWeeklyFeedbackByDateRange() {
			return [];
		},
		async getDailyTrainingLoadByDateRange() {
			return [
				{
					date: "2026-08-14",
					trainingDose: 0,
					acuteLoad: null,
					chronicLoad: null,
					form: null,
					loadRatio: null,
					readinessGate: null,
					coverageStatus: "unknown",
				},
			];
		},
		async getDailyRecoveryByDateRange() {
			return [];
		},
		async getUserInjuries() {
			return [];
		},
		async getLatestRunningCalibration() {
			return null;
		},
	});

	const snapshot = await provider.loadSnapshot(
		"athlete",
		"2026-08-14T00:00:00Z",
	);
	assert.equal(
		(snapshot.fitness_state.stride_training_load as Record<string, unknown>)
			.available,
		false,
	);
});
