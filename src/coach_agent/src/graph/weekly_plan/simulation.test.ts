import assert from "node:assert/strict";
import test from "node:test";
import { simulateWeeklyPlanLoad } from "./simulation.js";
import {
	createWeeklyPlanSimulationContext as context,
	createWeeklyPlanForSimulation as weeklyPlan,
} from "./testFixtures.js";

test("weekly simulator uses real session dates and projects the 7/42 PMC path", () => {
	const report = simulateWeeklyPlanLoad(weeklyPlan(), context());

	assert.equal(report.available, true);
	assert.equal(report.sessions.length, 2);
	assert.ok((report.total_dose ?? 0) > 0);
	assert.equal(
		report.days[0]?.estimated_dose,
		report.sessions[0]?.estimated_dose,
	);
	assert.equal(report.days[1]?.estimated_dose, 0);
	assert.equal(
		report.days[2]?.estimated_dose,
		report.sessions[1]?.estimated_dose,
	);
	assert.ok(report.days.every((day) => day.end_ctl !== null));
	assert.ok(
		report.sessions[1]?.load_assumptions.includes(
			"heart_rate_target_used_as_intensity_proxy",
		),
	);
});

test("weekly simulator rejects incomplete structured distance coverage", () => {
	const plan = weeklyPlan();
	const first = plan.sessions[0];
	assert.ok(first?.kind === "run" && first.spec);
	first.total_distance_m = 12_000;

	const report = simulateWeeklyPlanLoad(plan, context());

	assert.equal(report.available, false);
	assert.deepEqual(report.missing_dose_reasons, [
		"structured_distance_differs_from_session_total",
	]);
	assert.equal(report.sessions[0]?.estimated_dose, null);
});

test("weekly simulator reports missing athlete calibration without fallback constants", () => {
	const snapshot = context();
	snapshot.user_profile.threshold_speed_mps = null;

	const report = simulateWeeklyPlanLoad(weeklyPlan(), snapshot);

	assert.equal(report.available, false);
	assert.deepEqual(report.missing_dose_reasons, [
		"threshold_speed_calibration_missing",
	]);
	assert.equal(report.total_dose, null);
});

test("weekly simulator flags three consecutive projected overreach days", () => {
	const snapshot = context();
	const strideLoad = snapshot.fitness_state.stride_training_load as {
		available: boolean;
		acute_load: number;
		chronic_load: number;
	};
	assert.equal(strideLoad.available, true);
	strideLoad.acute_load = 120;
	strideLoad.chronic_load = 40;

	const report = simulateWeeklyPlanLoad(weeklyPlan(), snapshot);

	assert.deepEqual(report.safety_issues, [
		"planned_load_extends_overreach_more_than_1_25_to_3_consecutive_days",
	]);
});

test("weekly simulator does not blame a rest plan for pre-existing overreach", () => {
	const snapshot = context();
	const strideLoad = snapshot.fitness_state.stride_training_load as {
		available: boolean;
		acute_load: number;
		chronic_load: number;
	};
	strideLoad.acute_load = 120;
	strideLoad.chronic_load = 40;
	const plan = weeklyPlan();
	plan.sessions = [];

	const report = simulateWeeklyPlanLoad(plan, snapshot);

	assert.deepEqual(report.safety_issues, []);
	assert.ok(
		report.load_assumptions.includes(
			"preexisting_overreach_persists_without_planned_load",
		),
	);
});
