import assert from "node:assert/strict";
import test from "node:test";
import type { MasterPlan } from "@stride/contract";
import { simulateMasterPlanLoad, simulatePmcDays } from "./simulation.js";
import {
	createAssessmentSnapshot,
	createTestMasterPlan,
	createTestRequest,
} from "./testFixtures.js";

test("PMC uses canonical 7/42 day constants and daily update order", () => {
	const [day] = simulatePmcDays([100], { atl: 70, ctl: 60 });
	assert.ok(day);
	assert.equal(day.atl, 73.9937);
	assert.equal(day.ctl, 60.9411);
	assert.equal(day.form, -13.0525);
	assert.equal(day.ratio, 1.2142);
});

test("weekly simulator deterministically estimates a dose range and applies the default distribution", () => {
	const report = simulateMasterPlanLoad(
		createTestMasterPlan(),
		createAssessmentSnapshot(),
	);
	const first = report.weeks[0];
	assert.ok(first);
	assert.equal(report.algorithm_version, "master-plan-load-v3");
	assert.deepEqual(
		first.daily_distribution,
		[0.1, 0.18, 0.12, 0.18, 0.1, 0.27, 0.05],
	);
	assert.equal(first.estimated, true);
	assert.equal(
		first.provenance,
		"weekly_high_target+key_sessions+remaining_easy_volume",
	);
	assert.equal(first.confidence, "medium");
	assert.equal(first.estimated_dose, 408.5);
	assert.equal(first.estimated_dose_low, 339.5);
	assert.equal(first.estimated_dose_high, 430.5);
	assert.deepEqual(first.load_assumptions, [
		"structured_workout_segments_integrated",
		"remaining_weekly_distance_in_easy_zone",
	]);
	assert.equal(first.long_run_dose_share, 0.3012);
	assert.equal(first.end_ctl, 66.5202);
	assert.equal(first.end_atl, 63.9181);
	assert.equal(first.end_form, 2.602);
});

test("simulator does not report high confidence from low-confidence calibration", () => {
	const plan: MasterPlan = createTestMasterPlan();
	plan.weeks[0] = {
		...plan.weeks[0]!,
		target_weekly_km_low: 42.195,
		target_weekly_km_high: 42.195,
		key_sessions: [
			{
				type: "race",
				distance_km: 42.195,
				duration_min: 180,
				intensity: "goal race",
				purpose: "race",
			},
		],
	};
	const snapshot = createAssessmentSnapshot();
	assert.ok(snapshot.running_calibration);
	snapshot.running_calibration.threshold_speed_confidence = "low";
	const report = simulateMasterPlanLoad(plan, snapshot);

	assert.equal(
		report.weeks[0]!.estimated_dose_low,
		report.weeks[0]!.estimated_dose_high,
	);
	assert.equal(report.weeks[0]!.confidence, "medium");
});

test("simulator decays PMC state across the gap before plan start", () => {
	const snapshot = createAssessmentSnapshot();
	snapshot.fitness_state.as_of_date = "2026-08-01";
	const report = simulateMasterPlanLoad(createTestMasterPlan(), snapshot);
	assert.ok(
		report.weeks[0]!.end_ctl !== null && report.weeks[0]!.end_ctl < 66.5048,
	);
});

test("simulator marks weekly dose unavailable without threshold calibration", () => {
	const snapshot = { ...createAssessmentSnapshot(), running_calibration: null };
	const report = simulateMasterPlanLoad(
		createTestMasterPlan(),
		snapshot as never,
	);
	assert.equal(report.weeks[0]!.estimated_dose, null);
	assert.equal(report.weeks[0]!.confidence, "low");
	assert.equal(
		report.weeks[0]!.missing_dose_reason,
		"threshold_speed_calibration_missing",
	);
	assert.equal(report.weeks[0]!.end_ctl, null);
	assert.equal(report.weeks[0]!.end_atl, null);
	assert.equal(report.weeks[0]!.end_form, null);
});

test("simulator distinguishes an uncomputable session from missing calibration", () => {
	const plan: MasterPlan = createTestMasterPlan();
	plan.weeks[0]!.key_sessions[0] = {
		...plan.weeks[0]!.key_sessions[0]!,
		distance_km: null,
		duration_min: null,
		workout_structure: null,
	};
	const report = simulateMasterPlanLoad(plan, createAssessmentSnapshot());

	assert.equal(report.weeks[0]!.estimated_dose, null);
	assert.equal(
		report.weeks[0]!.missing_dose_reason,
		"planned_session_uncomputable",
	);
});

test("simulator accepts a plan starting Monday of the current snapshot week", () => {
	const snapshot = createAssessmentSnapshot();
	snapshot.fitness_state.as_of_date = "2026-08-11";
	const report = simulateMasterPlanLoad(createTestMasterPlan(), snapshot);
	assert.equal(report.weeks[0]!.confidence, "medium");
	assert.match(report.weeks[0]!.provenance, /^partial_current_week/);
	assert.ok(report.weeks[0]!.estimated_dose !== null);
	assert.ok(report.weeks[0]!.end_atl !== null && report.weeks[0]!.end_atl < 70);
});

test("simulator does not invent PMC state when the initial ATL or CTL is missing", () => {
	const snapshot = {
		...createAssessmentSnapshot(),
		fitness_state: { ...createAssessmentSnapshot().fitness_state, atl: null },
	};
	const report = simulateMasterPlanLoad(createTestMasterPlan(), snapshot);
	assert.ok(report.weeks[0]!.estimated_dose !== null);
	assert.equal(report.weeks[0]!.end_ctl, null);
	assert.equal(report.weeks[0]!.end_atl, null);
	assert.equal(report.weeks[0]!.end_form, null);
	assert.equal(
		report.weeks[0]!.missing_dose_reason,
		"initial_pmc_state_missing",
	);
});

test("simulator respects unavailable days and assigns the race to race day", () => {
	const report = simulateMasterPlanLoad(
		createTestMasterPlan(),
		createAssessmentSnapshot(),
		createTestRequest(),
	);
	assert.equal(report.weeks[0]!.daily_distribution[6], 0);
	assert.equal(report.weeks[1]!.daily_distribution[6], 0.85);
	assert.ok(
		report.weeks[1]!.daily_distribution.filter((share) => share > 0).length <=
			createTestRequest().availability.weekly_run_days_max,
	);
	assert.ok(
		Math.abs(
			report.weeks[0]!.daily_distribution.reduce(
				(sum, share) => sum + share,
				0,
			) - 1,
		) < 1e-9,
	);
	assert.ok(
		Math.abs(
			report.weeks[1]!.daily_distribution.reduce(
				(sum, share) => sum + share,
				0,
			) - 1,
		) < 1e-9,
	);
});

test("simulator limits routine load to explicit windows and weekly run-day maximum", () => {
	const request = createTestRequest();
	request.availability.weekly_run_days_max = 2;
	request.availability.available_training_windows =
		request.availability.available_training_windows.filter((window) =>
			["tuesday", "thursday", "saturday"].includes(window.day),
		);
	const report = simulateMasterPlanLoad(
		createTestMasterPlan(),
		createAssessmentSnapshot(),
		request,
	);
	const usedDays = report.weeks[0]!.daily_distribution.flatMap(
		(share, index) => (share > 0 ? [index] : []),
	);
	assert.deepEqual(usedDays, [1, 5]);
});

test("recovery weeks reduce expected dose while retaining an auditable daily Form path", () => {
	const plan: MasterPlan = createTestMasterPlan();
	plan.weeks[1] = {
		...plan.weeks[1]!,
		phase_name: "taper",
		target_weekly_km_low: 50,
		target_weekly_km_high: 60,
		key_sessions: [
			{
				type: "long_run",
				distance_km: 18,
				duration_min: null,
				intensity: "Z2 endurance",
				purpose: "reduced long run",
			},
		],
		is_recovery_week: true,
	};
	const report = simulateMasterPlanLoad(plan, createAssessmentSnapshot());
	const loadWeek = report.weeks[0]!;
	const recoveryWeek = report.weeks[1]!;

	assert.ok(recoveryWeek.estimated_dose! < loadWeek.estimated_dose! * 0.8);
	assert.ok(recoveryWeek.estimated_dose_low! < loadWeek.estimated_dose_low!);
	assert.ok(recoveryWeek.estimated_dose_high! < loadWeek.estimated_dose_high!);
	assert.ok(recoveryWeek.long_run_dose_share! < 0.33);

	const firstWeekDays = simulatePmcDays(
		loadWeek.daily_distribution.map(
			(share) => share * loadWeek.estimated_dose!,
		),
		{ atl: 70, ctl: 65 },
	);
	const firstWeekEnd = firstWeekDays.at(-1)!;
	const recoveryDays = simulatePmcDays(
		recoveryWeek.daily_distribution.map(
			(share) => share * recoveryWeek.estimated_dose!,
		),
		{ atl: firstWeekEnd.atl, ctl: firstWeekEnd.ctl },
	);
	assert.equal(recoveryDays.length, 7);
	assert.ok(recoveryDays.every((day) => Number.isFinite(day.form)));
	assert.ok(recoveryDays.at(-1)!.form > firstWeekEnd.form);
});
