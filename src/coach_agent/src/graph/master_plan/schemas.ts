import { z } from "zod/v4";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DaySchema = z
	.string()
	.regex(DAY)
	.refine((day) => {
		const date = new Date(`${day}T00:00:00Z`);
		return (
			!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === day
		);
	}, "expected a valid calendar day");
const UTC_ISO = /(?:Z|[+-]00:00)$/;
const EMBEDDED_RACE_PACE =
	/(?:\b(?:MP|HMP|RP)\b|race[- ]?pace|target[- ]?pace|比赛配速|目标配速|马拉松配速|半马配速)/i;
const ORDINARY_FILLER_PURPOSE =
	/^\s*(?:(?:ordinary|easy|recovery|filler|commute)\s+)*(?:easy|recovery|filler|commute)\s+run\s*[.!]?\s*$|^\s*(?:普通)?(?:轻松|恢复|填充|通勤)跑(?:训练)?\s*[。！]?\s*$/i;
const RACE_DISTANCE_KM = { FM: 42.195, HM: 21.0975 } as const;
const RACE_TIME = /^(\d+):(\d{2}):(\d{2})$/;

export const KeySessionTypeSchema = z.enum([
	"long_run",
	"threshold",
	"tempo",
	"interval",
	"vo2max",
	"hill",
	"race_pace",
	"time_trial",
	"tune_up_race",
	"race",
	"strength_key",
]);

export const StrategyArchetypeSchema = z.enum([
	"conservative",
	"balanced",
	"aggressive_gated",
]);

const StrategyPhaseSchema = z
	.object({
		name: z.string().min(1),
		weeks: z.int().positive(),
		focus: z.string().min(1),
		weekly_km_low: z.number().nonnegative(),
		weekly_km_high: z.number().nonnegative(),
	})
	.strict()
	.refine(
		(phase) => phase.weekly_km_low <= phase.weekly_km_high,
		"phase weekly low must not exceed high",
	);

export const StrategyCandidateSchema = z
	.object({
		schema_version: z.literal(1),
		candidate_id: z
			.string()
			.regex(/^strategy-(?:conservative|balanced|aggressive-gated)-v1$/),
		archetype: StrategyArchetypeSchema,
		phases: z.array(StrategyPhaseSchema).min(2),
		weekly_highs_km: z.array(z.number().nonnegative()).min(2),
		max_long_run_km: z.number().nonnegative(),
		max_quality_sessions_per_week: z.int().nonnegative(),
		race_week_index: z.int().positive(),
		load_curve: z.string().min(1),
		recovery_cadence: z.string().min(1),
		specific_progression: z.array(z.string().min(1)).min(1),
		milestones: z.array(z.string().min(1)).min(1),
		taper: z.string().min(1),
		strength: z.string().min(1),
		nutrition: z.string().min(1),
		risk_tradeoffs: z.array(z.string().min(1)).min(1),
		hard_constraints_satisfied: z.boolean(),
		hard_constraint_violations: z.array(z.string().min(1)),
		evidence_fact_ids: z.array(z.string().min(1)).min(1),
	})
	.strict()
	.superRefine((candidate, ctx) => {
		const expectedId = `strategy-${candidate.archetype.replace("_", "-")}-v1`;
		if (candidate.candidate_id !== expectedId)
			ctx.addIssue({
				code: "custom",
				path: ["candidate_id"],
				message: `must be ${expectedId}`,
			});
		if (
			candidate.hard_constraints_satisfied ===
			candidate.hard_constraint_violations.length > 0
		)
			ctx.addIssue({
				code: "custom",
				path: ["hard_constraint_violations"],
				message: "must agree with hard_constraints_satisfied",
			});
	});
export type StrategyCandidate = z.infer<typeof StrategyCandidateSchema>;

export const StrategyJudgmentSchema = z
	.object({
		schema_version: z.literal(1),
		judge: z.enum([
			"performance_path",
			"safety_load",
			"constraint_feasibility",
		]),
		candidate_id: StrategyCandidateSchema.shape.candidate_id,
		score: z.int().min(1).max(5),
		veto: z.boolean(),
		rationale: z.string().min(1),
		evidence_fact_ids: z.array(z.string().min(1)).min(1),
	})
	.strict();
export type StrategyJudgment = z.infer<typeof StrategyJudgmentSchema>;

export const SelectedStrategySchema = z
	.object({
		candidate: StrategyCandidateSchema,
		scores: z
			.object({
				performance_path: z.int().min(1).max(5),
				safety_load: z.int().min(1).max(5),
				constraint_feasibility: z.int().min(1).max(5),
				weighted_total: z.number().min(1).max(5),
			})
			.strict(),
		weights: z
			.object({
				performance_path: z.literal(0.45),
				safety_load: z.literal(0.35),
				constraint_feasibility: z.literal(0.2),
			})
			.strict(),
		rationale: z.string().min(1),
		tradeoffs: z.array(z.string().min(1)).min(1),
	})
	.strict();
export type SelectedStrategy = z.infer<typeof SelectedStrategySchema>;

const MilestoneSchema = z.object({
	type: z.enum([
		"race",
		"test_run",
		"long_run",
		"strength_test",
		"body_composition",
	]),
	date: DaySchema,
	target: z.string(),
	completed_actual: z.string().nullable(),
});

const StrengthSchema = z.object({
	sessions_per_week: z.int().nonnegative(),
	focus: z.string().min(1),
	timing: z.string().min(1),
});

const RecoverySchema = z.object({
	focus: z.string().min(1),
	sleep_target_hours: z.string().min(1),
	adjustment_trigger: z.string().min(1),
});

const WorkoutDurationSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.enum(["time_s", "distance_m"]),
			value: z.number().positive(),
		})
		.strict(),
	z.object({ kind: z.literal("open"), value: z.null() }).strict(),
]);

const WorkoutTargetSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.enum(["pace_s_km", "hr_bpm"]),
			low: z.number().positive(),
			high: z.number().positive(),
		})
		.strict(),
	z.object({ kind: z.literal("open"), low: z.null(), high: z.null() }).strict(),
]);

const WorkoutStepSchema = z
	.object({
		step_kind: z.enum(["warmup", "work", "recovery", "cooldown", "rest"]),
		duration: WorkoutDurationSchema,
		target: WorkoutTargetSchema,
		note: z.string().nullable().optional(),
		hr_cap_bpm: z.int().positive().nullable().optional(),
	})
	.strict();

const WorkoutStructureSchema = z
	.object({
		schema: z.literal("run-workout/v1"),
		name: z.string().min(1),
		date: DaySchema,
		note: z.string().nullable(),
		blocks: z
			.array(
				z
					.object({
						repeat: z.int().positive(),
						steps: z.array(WorkoutStepSchema).min(1),
					})
					.strict(),
			)
			.min(1),
	})
	.strict()
	.describe(
		"Canonical running-workout blocks. Repeated interval work and recovery belong in the same block.",
	);

const PhaseSchema = z
	.object({
		name: z.enum([
			"基础期",
			"提升期",
			"专项速度周期",
			"马拉松专项期",
			"赛前减量期",
			"赛后恢复期",
		]),
		start_date: DaySchema,
		end_date: DaySchema,
		focus: z.string(),
		weekly_distance_km_low: z.number().nonnegative(),
		weekly_distance_km_high: z.number().nonnegative(),
		key_session_types: z.array(z.string()),
		milestones: z.array(MilestoneSchema),
		key_workouts: z.string(),
		monitoring_triggers: z.array(z.string()),
		coach_note: z.string(),
		strength: StrengthSchema,
		recovery: RecoverySchema,
		is_completed: z.boolean(),
		summary: z.string().nullable(),
	})
	.superRefine((phase, ctx) => {
		if (!phase.is_completed && phase.summary !== null) {
			ctx.addIssue({
				code: "custom",
				path: ["summary"],
				message: "must be null for an incomplete phase",
			});
		}
	});

const KeySessionSchema = z
	.object({
		type: KeySessionTypeSchema.describe(
			"Classify the complete standalone workout, not an interval or pace segment embedded inside another workout.",
		),
		distance_km: z
			.number()
			.nonnegative()
			.nullable()
			.describe(
				"Total distance of this complete workout. Do not put only the distance of its work intervals here.",
			),
		duration_min: z
			.number()
			.nonnegative()
			.nullable()
			.describe(
				"Total elapsed duration of this complete workout, including warm-up, recoveries, and cool-down; not only work-interval time.",
			),
		intensity: z
			.string()
			.nullable()
			.describe(
				"Describe every component of this one workout here, including any race-pace blocks embedded in a long run.",
			),
		purpose: z.string().nullable(),
		workout_structure: WorkoutStructureSchema.nullish().describe(
			"Machine-readable structure for this complete running workout. Use null only for strength sessions or legacy plans.",
		),
	})
	.describe(
		"Exactly one independently performed workout. Embedded blocks are components of this object and must not be repeated as sibling key_sessions.",
	);

const WeekSchema = z
	.object({
		week_index: z.int().positive(),
		week_start: DaySchema,
		phase_name: PhaseSchema.shape.name,
		target_weekly_km_low: z.number().nonnegative(),
		target_weekly_km_high: z.number().nonnegative(),
		key_sessions: z
			.array(KeySessionSchema)
			.describe(
				"Strategic workouts for the week. Each object is one independently performed workout, never a component of another object.",
			),
		is_recovery_week: z.boolean(),
	})
	.superRefine((week, ctx) => {
		if (week.key_sessions.length > (week.is_recovery_week ? 1 : 3)) {
			ctx.addIssue({
				code: "custom",
				path: ["key_sessions"],
				message: week.is_recovery_week
					? "recovery weeks may contain at most one strategic key session"
					: "weeks may contain at most three strategic key sessions",
			});
		}
		const raceSessions = week.key_sessions.filter(
			(session) => session.type === "race",
		);
		const raceWeekCompanions = week.key_sessions.filter(
			(session) => session.type !== "race",
		);
		if (
			raceSessions.length > 0 &&
			(raceSessions.length !== 1 ||
				raceWeekCompanions.length > 1 ||
				raceWeekCompanions.some((session) => session.type !== "race_pace"))
		) {
			ctx.addIssue({
				code: "custom",
				path: ["key_sessions"],
				message:
					"race weeks may contain the target race and at most one race-pace activation session",
			});
		}
		for (const [index, session] of week.key_sessions.entries()) {
			const structure = session.workout_structure;
			if (session.type !== "strength_key" && !structure)
				ctx.addIssue({
					code: "custom",
					path: ["key_sessions", index, "workout_structure"],
					message: "running key sessions require workout_structure",
				});
			if (structure) {
				const weekEnd = new Date(`${week.week_start}T00:00:00Z`);
				weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
				if (
					structure.date < week.week_start ||
					structure.date > weekEnd.toISOString().slice(0, 10)
				)
					ctx.addIssue({
						code: "custom",
						path: ["key_sessions", index, "workout_structure", "date"],
						message: "must fall inside the containing Monday-Sunday week",
					});
				for (const [blockIndex, block] of structure.blocks.entries())
					for (const [stepIndex, step] of block.steps.entries())
						if (step.step_kind === "work" && step.target.kind === "open")
							ctx.addIssue({
								code: "custom",
								path: [
									"key_sessions",
									index,
									"workout_structure",
									"blocks",
									blockIndex,
									"steps",
									stepIndex,
									"target",
								],
								message: "work steps require an explicit target",
							});
				const activeSteps = structure.blocks
					.flatMap((block) =>
						Array.from({ length: block.repeat }, () => block.steps).flat(),
					)
					.filter((step) => step.step_kind !== "rest");
				if (
					session.distance_km !== null &&
					activeSteps.every((step) => step.duration.kind === "distance_m")
				) {
					const structuredDistanceKm = activeSteps.reduce(
						(total, step) =>
							total +
							(step.duration.kind === "distance_m"
								? step.duration.value / 1000
								: 0),
						0,
					);
					if (Math.abs(session.distance_km - structuredDistanceKm) > 0.01)
						ctx.addIssue({
							code: "custom",
							path: ["key_sessions", index, "distance_km"],
							message:
								"must equal the complete distance-based workout_structure total",
						});
				}
			}
			if (ORDINARY_FILLER_PURPOSE.test(session.purpose ?? "")) {
				ctx.addIssue({
					code: "custom",
					path: ["key_sessions", index],
					message:
						"ordinary easy/recovery/filler runs do not belong in the strategic skeleton",
				});
			}
		}
		const hasEmbeddedRacePaceLongRun = week.key_sessions.some(
			(session) =>
				session.type === "long_run" &&
				EMBEDDED_RACE_PACE.test(
					`${session.intensity ?? ""} ${session.purpose ?? ""}`,
				),
		);
		if (
			hasEmbeddedRacePaceLongRun &&
			week.key_sessions.some(
				(session) =>
					session.type === "race_pace" &&
					session.workout_structure &&
					week.key_sessions.some(
						(longRun) =>
							longRun.type === "long_run" &&
							longRun.workout_structure?.date ===
								session.workout_structure?.date &&
							EMBEDDED_RACE_PACE.test(
								`${longRun.intensity ?? ""} ${longRun.purpose ?? ""}`,
							),
					),
			)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["key_sessions"],
				message:
					"embedded race-pace work must be represented only by its long_run session",
			});
		}
	});

/** Canonical machine-enforced contract for newly generated season plans. */
export const MasterPlanSchema = z
	.object({
		status: z.literal("draft"),
		goal: z.object({
			race_name: z.string(),
			distance: z.enum(["FM", "HM"]),
			race_date: DaySchema,
			target_time: z.string(),
			timezone: z.literal("Asia/Shanghai"),
			location: z.string().min(1).nullish(),
		}),
		start_date: DaySchema,
		end_date: DaySchema,
		total_weeks: z.int().positive(),
		phases: z.array(PhaseSchema).min(1),
		weeks: z.array(WeekSchema).min(1),
		training_principles: z.array(z.string()).min(1),
		generated_by: z.literal("coach_agent"),
		version: z.literal(1),
		created_at: z.string().regex(UTC_ISO),
		updated_at: z.string().regex(UTC_ISO),
	})
	.superRefine((plan, ctx) => {
		if (plan.total_weeks !== plan.weeks.length) {
			ctx.addIssue({
				code: "custom",
				path: ["total_weeks"],
				message: "must equal weeks.length",
			});
		}
		if (
			new Set(plan.phases.map((phase) => phase.name)).size !==
			plan.phases.length
		) {
			ctx.addIssue({
				code: "custom",
				path: ["phases"],
				message: "phase names must be unique",
			});
		}
		for (const [index, week] of plan.weeks.entries()) {
			if (week.week_index !== index + 1) {
				ctx.addIssue({
					code: "custom",
					path: ["weeks", index, "week_index"],
					message: "must be consecutive from 1",
				});
			}
			if (week.key_sessions.some((session) => session.type === "race")) {
				const activation = week.key_sessions.find(
					(session) => session.type === "race_pace",
				);
				if (activation && !activation.workout_structure)
					ctx.addIssue({
						code: "custom",
						path: [
							"weeks",
							index,
							"key_sessions",
							week.key_sessions.indexOf(activation),
							"workout_structure",
						],
						message: "race-week activation requires workout_structure",
					});
				if (activation?.workout_structure) {
					const goalPaceSPerKm = targetPaceSPerKm(
						plan.goal.target_time,
						RACE_DISTANCE_KM[plan.goal.distance],
					);
					const workDistanceKm = activation.workout_structure.blocks.reduce(
						(total, block) =>
							total +
							block.repeat *
								block.steps.reduce(
									(sum, step) =>
										sum +
										(step.step_kind === "work" &&
										step.duration.kind === "distance_m" &&
										targetsGoalRacePace(step.target, goalPaceSPerKm)
											? step.duration.value / 1000
											: 0),
									0,
								),
						0,
					);
					const [minimum, maximum] =
						plan.goal.distance === "FM" ? [10, 15] : [8, 10];
					if (workDistanceKm < minimum || workDistanceKm > maximum)
						ctx.addIssue({
							code: "custom",
							path: [
								"weeks",
								index,
								"key_sessions",
								week.key_sessions.indexOf(activation),
								"workout_structure",
							],
							message: `race-week ${plan.goal.distance} activation requires ${minimum}-${maximum}km of race-pace work`,
						});
				}
			}
		}
	});

export type MasterPlan = z.infer<typeof MasterPlanSchema>;

function targetPaceSPerKm(
	targetTime: string,
	distanceKm: number,
): number | null {
	const match = RACE_TIME.exec(targetTime);
	if (!match) return null;
	const [, hours, minutes, seconds] = match;
	const totalSeconds =
		Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
	return totalSeconds > 0 ? totalSeconds / distanceKm : null;
}

function targetsGoalRacePace(
	target: z.infer<typeof WorkoutTargetSchema>,
	goalPaceSPerKm: number | null,
): boolean {
	if (target.kind !== "pace_s_km" || goalPaceSPerKm === null) return false;
	const fastest = Math.min(target.low, target.high);
	const slowest = Math.max(target.low, target.high);
	return fastest >= goalPaceSPerKm * 0.97 && slowest <= goalPaceSPerKm * 1.03;
}
