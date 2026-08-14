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

test("weekly context combines all weekly planning evidence", async () => {
	const ranges: Array<[string, string, string]> = [];
	const provider = new MySqlWeeklyPlanContextProvider({
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
				},
			};
		},
		async getActivitiesByDateRange(userId, start, end) {
			ranges.push([userId, start, end]);
			return [activity];
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
	assert.equal(snapshot.training_position.stage, null);
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

test("weekly context keeps a Monday as the planning start", async () => {
	const provider = new MySqlWeeklyPlanContextProvider({
		async getMasterPlanMetadataForDate() {
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

	const snapshot = await provider.loadSnapshot("athlete", "2026-08-17");
	assert.equal(snapshot.plan_start, "2026-08-17");
});

test("weekly context reports unavailable STRIDE load without fallback", async () => {
	const provider = new MySqlWeeklyPlanContextProvider({
		async getMasterPlanMetadataForDate() {
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
