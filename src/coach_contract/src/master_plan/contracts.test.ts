import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanGraphOutcome, MasterPlanGraphRequest } from "./contracts.js";

function createTestRequest() {
	return {
		request_id: "request-342",
		requested_mode: "new_season" as const,
		requested_modifiers: [],
		goals: [
			{
				race_name: "西安马拉松",
				location: "西安",
				distance: "FM" as const,
				race_date: "2026-10-18",
				target_time: "2:50:00",
				finish_only: false,
				priority: "A" as const,
			},
		],
		availability: {
			weekly_run_days_max: 6,
			available_training_windows: [
				{ day: "monday" as const, start_time: "06:00", end_time: "08:00" },
				{ day: "tuesday" as const, start_time: "06:00", end_time: "08:00" },
				{ day: "wednesday" as const, start_time: "06:00", end_time: "08:00" },
				{ day: "thursday" as const, start_time: "06:00", end_time: "08:00" },
				{ day: "friday" as const, start_time: "06:00", end_time: "08:00" },
				{ day: "saturday" as const, start_time: "06:00", end_time: "09:00" },
			],
			unavailable_days: ["sunday" as const],
			max_session_duration_min: 180,
			allows_double_sessions: false,
			preferred_long_run_day: "saturday" as const,
			strength_sessions_per_week: 2,
			strength_available_days: ["monday" as const, "thursday" as const],
		},
		injury_declarations: [],
		environment_constraints: [],
		travel_constraints: [],
		preferences: [],
		prohibited_arrangements: [],
		active_plan_action: "none" as const,
		user_confirmations: {
			intake_complete: true as const,
			goals_confirmed: true as const,
			availability_confirmed: true as const,
			injury_history_confirmed: true as const,
			constraints_confirmed: true as const,
		},
	};
}

test("request accepts explicit empty constraints in a complete confirmed intake", () => {
	const request = createTestRequest();
	assert.deepEqual(MasterPlanGraphRequest.parse(request), request);
});

test("request accepts an omitted or null race location", () => {
	const request = createTestRequest();
	const goal = request.goals[0];
	assert.ok(goal);
	const { location: _location, ...goalWithoutLocation } = goal;
	const withoutLocation = { ...request, goals: [goalWithoutLocation] };
	assert.equal(MasterPlanGraphRequest.safeParse(withoutLocation).success, true);

	const withNullLocation = {
		...request,
		goals: [{ ...goal, location: null }],
	};
	assert.equal(
		MasterPlanGraphRequest.safeParse(withNullLocation).success,
		true,
	);
});

test("request rejects omitted intake fields and unconfirmed answers", () => {
	const { preferences: _, ...missingPreferences } = createTestRequest();
	assert.equal(
		MasterPlanGraphRequest.safeParse(missingPreferences).success,
		false,
	);

	const unconfirmed = createTestRequest();
	const invalidConfirmation = {
		...unconfirmed,
		user_confirmations: {
			...unconfirmed.user_confirmations,
			constraints_confirmed: false,
		},
	};
	assert.equal(
		MasterPlanGraphRequest.safeParse(invalidConfirmation).success,
		false,
	);
});

test("request rejects ambiguous primary race priorities", () => {
	const request = createTestRequest();
	const ambiguous = {
		...request,
		goals: [
			...request.goals,
			{ ...request.goals[0]!, race_name: "上海马拉松", location: "上海" },
		],
	};

	assert.equal(MasterPlanGraphRequest.safeParse(ambiguous).success, false);
});

test("request rejects malformed race target times instead of treating them as finish-only", () => {
	const request = createTestRequest();
	request.goals[0]!.target_time = "2:50";
	assert.equal(MasterPlanGraphRequest.safeParse(request).success, false);
});

test("outcome accepts minimal non-completed decisions", () => {
	const clarification = {
		decision: "needs_clarification",
		request_id: "request-342",
		generation_id: "generation-342",
		questions: [{ question_id: "q1", intent: "confirm goal" }],
	};
	assert.equal(MasterPlanGraphOutcome.safeParse(clarification).success, true);
});
