import assert from "node:assert/strict";
import test from "node:test";
import {
	ContextSnapshotSchema,
	MasterPlanGraphRequest,
	MasterPlanSchema,
} from "./index.js";
import { runMasterPlanRuleFilter } from "./rules.js";
import {
	createAssessmentSnapshot,
	createTestMasterPlan,
	createTestRequest,
} from "./testFixtures.js";

const check = (
	plan: unknown = createTestMasterPlan(),
	mutateRequest?: (request: ReturnType<typeof createTestRequest>) => void,
) => {
	const request = MasterPlanGraphRequest.parse(createTestRequest());
	mutateRequest?.(request as ReturnType<typeof createTestRequest>);
	return runMasterPlanRuleFilter(plan, request, createAssessmentSnapshot());
};
const ids = (report: ReturnType<typeof check>) =>
	report.violations.map((item) => item.rule_id);
const mutated = (
	change: (plan: ReturnType<typeof MasterPlanSchema.parse>) => void,
) => {
	const plan = MasterPlanSchema.parse(createTestMasterPlan());
	change(plan);
	return plan;
};

test("schema_validity reports malformed artifacts without throwing", () =>
	assert.deepEqual(ids(check({ status: "draft" })), ["schema_validity"]));
test("schema_validity reports impossible calendar dates without throwing", () => {
	const plan = createTestMasterPlan();
	plan.start_date = "2026-99-99";
	assert.deepEqual(ids(check(plan)), ["schema_validity"]);
});
test("natural_week_sequence catches a non-Monday gap", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.weeks[1]!.week_start = "2026-08-19";
				}),
			),
		).includes("natural_week_sequence"),
	));
test("natural_week_sequence anchors the first week to plan start", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.start_date = "2026-08-03";
				}),
			),
		).includes("natural_week_sequence"),
	));
test("phase_timeline_coverage catches a phase gap", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.phases[1]!.start_date = "2026-08-18";
				}),
			),
		).includes("phase_timeline_coverage"),
	));
test("week_phase_alignment catches the known phase/week mismatch", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.weeks[0]!.phase_name = "赛前减量期";
				}),
			),
		).includes("week_phase_alignment"),
	));
test("week_phase_alignment rejects a phase ending mid-week", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.phases[0]!.end_date = "2026-08-12";
					p.phases[1]!.start_date = "2026-08-13";
				}),
			),
		).includes("week_phase_alignment"),
	));
test("volume_range_consistency checks week against phase", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.weeks[0]!.target_weekly_km_low = 50;
				}),
			),
		).includes("volume_range_consistency"),
	));
test("load_week_ramp retains the pre-recovery anchor", () => {
	const plan = mutated((p) => {
		const w = structuredClone(p.weeks[0]!);
		w.week_index = 2;
		w.week_start = "2026-08-17";
		w.key_sessions[0]!.workout_structure!.date = "2026-08-18";
		w.is_recovery_week = true;
		w.target_weekly_km_high = 50;
		w.target_weekly_km_low = 45;
		const next = structuredClone(p.weeks[0]!);
		next.week_index = 3;
		next.week_start = "2026-08-24";
		next.key_sessions[0]!.workout_structure!.date = "2026-08-25";
		next.target_weekly_km_high = 90;
		p.weeks = [p.weeks[0]!, w, next];
		p.total_weeks = 3;
		p.end_date = "2026-08-30";
		p.phases = [
			{ ...p.phases[0]!, end_date: "2026-08-30", weekly_distance_km_high: 90 },
		];
	});
	assert.ok(ids(check(plan)).includes("load_week_ramp"));
});
test("recovery_cadence warns after four consecutive load weeks", () => {
	const plan = mutated((p) => {
		p.weeks = Array.from({ length: 5 }, (_, i) => {
			const date = new Date("2026-08-10T00:00:00Z");
			date.setUTCDate(date.getUTCDate() + i * 7);
			return {
				...structuredClone(p.weeks[0]!),
				week_index: i + 1,
				week_start: date.toISOString().slice(0, 10),
				key_sessions: p.weeks[0]!.key_sessions.map((session) => ({
					...structuredClone(session),
					workout_structure: session.workout_structure
						? {
								...structuredClone(session.workout_structure),
								date: date.toISOString().slice(0, 10),
							}
						: null,
				})),
			};
		});
		p.total_weeks = 5;
		p.end_date = "2026-09-13";
		p.phases = [{ ...p.phases[0]!, end_date: "2026-09-13" }];
	});
	assert.equal(
		check(plan).violations.find((v) => v.rule_id === "recovery_cadence")
			?.severity,
		"warning",
	);
});
test("taper_volume_drop rejects an insufficient taper", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.weeks[1]!.target_weekly_km_high = 65;
					p.phases[1]!.weekly_distance_km_high = 65;
				}),
			),
		).includes("taper_volume_drop"),
	));
test("hard_stimulus_density counts hard work after a hard session but ignores negated MP", () => {
	const plan = mutated((p) => {
		const structure = p.weeks[0]!.key_sessions[0]!.workout_structure;
		if (!structure) throw new Error("structured test fixture missing");
		const sessionStructure = (name: string, distanceM: number) => ({
			...structuredClone(structure),
			name,
			blocks: structure.blocks.map((block) => ({
				...structuredClone(block),
				steps: block.steps.map((step) => ({
					...structuredClone(step),
					duration: { kind: "distance_m" as const, value: distanceM },
				})),
			})),
		});
		p.weeks[0]!.key_sessions = [
			{
				type: "threshold",
				distance_km: 10,
				duration_min: 50,
				intensity: "threshold",
				purpose: "quality",
				workout_structure: sessionStructure("threshold", 10000),
			},
			{
				type: "interval",
				distance_km: 10,
				duration_min: 50,
				intensity: "interval",
				purpose: "quality",
				workout_structure: sessionStructure("interval", 10000),
			},
			{
				type: "long_run",
				distance_km: 20,
				duration_min: 120,
				intensity: "不含MP专项段",
				purpose: "耐力",
				workout_structure: sessionStructure("long run", 20000),
			},
		];
	});
	assert.ok(!ids(check(plan)).includes("hard_stimulus_density"));
	plan.weeks[0]!.key_sessions[2]!.intensity = "含MP专项段";
	const parsed = MasterPlanSchema.safeParse(plan);
	assert.equal(parsed.success, true, parsed.error?.message ?? "schema invalid");
	assert.ok(ids(check(plan)).includes("hard_stimulus_density"));
});
test("long_run_share applies default and frequency_limited thresholds", () => {
	const plan = mutated((p) => {
		p.weeks[0]!.key_sessions[0]!.distance_km = 30;
		const step =
			p.weeks[0]!.key_sessions[0]!.workout_structure?.blocks[0]?.steps[0];
		if (!step) throw new Error("structured test fixture missing");
		step.duration = { kind: "distance_m", value: 30000 };
	});
	assert.ok(ids(check(plan)).includes("long_run_share"));
	assert.ok(
		!ids(
			check(plan, (r) => {
				r.availability.weekly_run_days_max = 3;
			}),
		).includes("long_run_share"),
	);
});
test("race_week_volume includes the race distance", () =>
	assert.ok(
		ids(
			check(
				mutated((p) => {
					p.weeks[1]!.target_weekly_km_high = 40;
					p.phases[1]!.weekly_distance_km_low = 35;
					p.phases[1]!.weekly_distance_km_high = 40;
				}),
			),
		).includes("race_week_volume"),
	));
test("availability_constraints checks key count, explicit duration, calibrated slow edge, and missing calibration warning", () => {
	const plan = mutated((p) => {
		p.weeks[0]!.key_sessions[0]!.distance_km = 80;
		const step =
			p.weeks[0]!.key_sessions[0]!.workout_structure?.blocks[0]?.steps[0];
		if (!step) throw new Error("structured test fixture missing");
		step.duration = { kind: "distance_m", value: 80000 };
	});
	assert.ok(
		ids(
			check(plan, (r) => {
				r.availability.max_session_duration_min = 60;
			}),
		).includes("availability_constraints"),
	);
	const snapshot = ContextSnapshotSchema.parse({
		...createAssessmentSnapshot(),
		running_calibration: null,
	});
	const report = runMasterPlanRuleFilter(plan, createTestRequest(), snapshot);
	assert.ok(
		report.violations.some(
			(v) =>
				v.rule_id === "availability_duration_unverifiable" &&
				v.severity === "warning",
		),
	);
});
test("availability reports sessions with neither duration nor distance", () => {
	const plan = mutated((p) => {
		p.weeks[0]!.key_sessions[0]!.distance_km = null;
		p.weeks[0]!.key_sessions[0]!.duration_min = null;
	});
	assert.ok(ids(check(plan)).includes("availability_duration_unverifiable"));
});
test("availability duration uses the calibrated pace-zone slow edge", () => {
	const plan = mutated((p) => {
		p.weeks[0]!.key_sessions[0]!.distance_km = 20;
		p.weeks[0]!.key_sessions[0]!.duration_min = null;
		const step =
			p.weeks[0]!.key_sessions[0]!.workout_structure?.blocks[0]?.steps[0];
		if (!step) throw new Error("structured test fixture missing");
		step.duration = { kind: "distance_m", value: 20000 };
	});
	const snapshot = ContextSnapshotSchema.parse({
		...createAssessmentSnapshot(),
		running_calibration: {
			...createAssessmentSnapshot().running_calibration!,
			pace_zones: [{ name: "easy", maxPaceSPerKm: 360 }],
		},
	});
	const request = MasterPlanGraphRequest.parse({
		...createTestRequest(),
		availability: {
			...createTestRequest().availability,
			max_session_duration_min: 110,
		},
	});
	const report = runMasterPlanRuleFilter(plan, request, snapshot);
	assert.ok(ids(report).includes("availability_constraints"));
});
