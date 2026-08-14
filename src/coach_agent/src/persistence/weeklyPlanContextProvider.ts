import {
	addDays,
	mondayOnOrBefore as monday,
	planningStartDate,
	shanghaiDay,
	weekFolder,
} from "../utils/planningDate.js";
import type {
	ActiveMasterPlanMetadata,
	Activity,
	DailyRecovery,
	DailyTrainingLoad,
	RunningCalibration,
	StrideDataStore,
	UserInjury,
	WeeklyFeedback,
} from "./dataStore.js";
import {
	createWeeklyFeedbackSource,
	type WeeklyFeedbackSource,
} from "./weeklyFeedbackSource.js";

type ContextStore = Pick<
	StrideDataStore,
	| "getMasterPlanMetadataForDate"
	| "getActivitiesByDateRange"
	| "getDailyRecoveryByDateRange"
	| "getDailyTrainingLoadByDateRange"
	| "getLatestRunningCalibration"
	| "getUserInjuries"
	| "getWeeklyFeedbackByDateRange"
>;

export interface WeeklyPlanContextProvider {
	loadSnapshot(userId: string, asOf: string): Promise<WeeklyPlanContext>;
}

export interface WeeklyPlanContext {
	as_of: string;
	plan_start: string;
	week_folder: string;
	lookback: { start_date: string; end_date: string; days: number };
	training_position: {
		phase: Record<string, unknown> | null;
		stage: Record<string, unknown> | null;
	};
	recent_activities: Array<Record<string, unknown>>;
	recent_feedback: Array<Record<string, unknown>>;
	fitness_state: Record<string, unknown>;
	injury_and_recovery: Record<string, unknown>;
	running_calibration: Record<string, unknown> | null;
}

const LOOKBACK_DAYS = 28;

export class MySqlWeeklyPlanContextProvider
	implements WeeklyPlanContextProvider
{
	private readonly feedbackSource: WeeklyFeedbackSource;

	constructor(
		private readonly store: ContextStore,
		options: {
			weeklyFeedbackCutoverComplete?: boolean;
			legacyDataDir?: string;
		} = {},
	) {
		this.feedbackSource = createWeeklyFeedbackSource(store, {
			...(options.weeklyFeedbackCutoverComplete === undefined
				? {}
				: { cutoverComplete: options.weeklyFeedbackCutoverComplete }),
			...(options.legacyDataDir === undefined
				? {}
				: { legacyDataDir: options.legacyDataDir }),
		});
	}

	public async loadSnapshot(
		userId: string,
		asOf: string,
	): Promise<WeeklyPlanContext> {
		const end = shanghaiDay(asOf);
		const planStart = planningStartDate(end);
		const start = addDays(end, -(LOOKBACK_DAYS - 1));
		const feedbackStart = monday(start);
		const [plan, activities, feedback, loads, recovery, injuries, calibration] =
			await Promise.all([
				this.store.getMasterPlanMetadataForDate(userId, planStart),
				this.store.getActivitiesByDateRange(userId, start, end),
				this.feedbackSource.getByDateRange(userId, feedbackStart, end),
				this.store.getDailyTrainingLoadByDateRange(userId, start, end),
				this.store.getDailyRecoveryByDateRange(userId, start, end),
				this.store.getUserInjuries(userId),
				this.store.getLatestRunningCalibration(userId, end),
			]);

		return {
			as_of: end,
			plan_start: planStart,
			week_folder: weekFolder(planStart),
			lookback: { start_date: start, end_date: end, days: LOOKBACK_DAYS },
			training_position: trainingPosition(plan, planStart),
			recent_activities: activities.map(activityShape),
			recent_feedback: feedback.map(feedbackShape),
			fitness_state: fitnessShape(loads, end),
			injury_and_recovery: recoveryShape(injuries, recovery, end),
			running_calibration: calibrationShape(calibration),
		};
	}
}

function trainingPosition(plan: ActiveMasterPlanMetadata | null, day: string) {
	if (!plan) return { phase: null, stage: null };
	const phases = records(plan.content.phases);
	const weeks = records(plan.content.weeks);
	const phase = phases.find((candidate) => containsDay(candidate, day));
	const weekStart = monday(day);
	const stage = weeks.find(
		(candidate) => string(candidate.week_start) === weekStart,
	);
	return {
		phase: phase
			? {
					name: string(phase.name),
					start_date: string(phase.start_date),
					end_date: string(phase.end_date),
					focus: string(phase.focus),
				}
			: null,
		stage: stage
			? {
					week_index: number(stage.week_index),
					week_start: string(stage.week_start),
					phase_name: string(stage.phase_name),
					is_recovery_week: boolean(stage.is_recovery_week),
					target_weekly_km_low: number(stage.target_weekly_km_low),
					target_weekly_km_high: number(stage.target_weekly_km_high),
					key_sessions: Array.isArray(stage.key_sessions)
						? stage.key_sessions
						: [],
				}
			: null,
	};
}

function activityShape(activity: Activity) {
	return {
		date: activityDay(activity),
		label_id: activity.labelId,
		name: activity.name,
		sport: activity.sport,
		training_type: activity.trainKind,
		distance_km:
			activity.distanceM === null ? null : round(activity.distanceM / 1000, 2),
		duration_min:
			activity.durationS === null ? null : round(activity.durationS / 60, 1),
		avg_pace_s_km: activity.avgPaceSKm,
		avg_hr: activity.avgHr,
		max_hr: activity.maxHr,
		training_dose: activity.strideDose,
		feedback: activity.feel,
		note: activity.sportNote,
	};
}

function feedbackShape(feedback: WeeklyFeedback) {
	return {
		week_start: feedback.weekStart,
		content_md: truncate(feedback.contentMd, 12_000),
		updated_at: feedback.updatedAt.toISOString(),
	};
}

function fitnessShape(loads: DailyTrainingLoad[], day: string) {
	const latest = loads.at(-1);
	const available =
		latest !== undefined &&
		[latest.acuteLoad, latest.chronicLoad, latest.form, latest.loadRatio].some(
			(value) => value !== null,
		);
	if (!latest || !available) {
		return {
			as_of_date: day,
			stride_training_load: {
				available: false,
				missing_reason: "stride_load_not_computed",
			},
			trend: [],
			provenance: { source: "stride", vendor_derived: false },
		};
	}
	return {
		as_of_date: latest.date,
		stride_training_load: {
			available: true,
			acute_load: latest.acuteLoad,
			chronic_load: latest.chronicLoad,
			form: latest.form,
			load_ratio: latest.loadRatio,
		},
		trend: loads.slice(-14).map((load) => ({
			date: load.date,
			training_dose: load.trainingDose,
			acute_load: load.acuteLoad,
			chronic_load: load.chronicLoad,
			form: load.form,
			load_ratio: load.loadRatio,
			coverage_status: load.coverageStatus,
		})),
		provenance: { source: "stride", vendor_derived: false },
	};
}

function recoveryShape(
	injuries: UserInjury[],
	recovery: DailyRecovery[],
	asOfDay: string,
) {
	const measured = recovery.filter(
		(row) => row.rhr !== null || row.hrv !== null,
	);
	const latest = measured.at(-1) ?? null;
	const sevenDayStart = addDays(asOfDay, -6);
	const recent = measured.filter(
		(row) => row.date >= sevenDayStart && row.date <= asOfDay,
	);
	return {
		injuries: injuries.map((injury) => ({
			description: injury.description,
			recovery_status: injury.recoveryStatus,
			running_restriction: injury.runningRestriction,
		})),
		recovery: {
			latest,
			seven_day_average: {
				rhr: average(recent.map((row) => row.rhr)),
				hrv: average(recent.map((row) => row.hrv)),
			},
			history: measured.slice(-14),
			provenance: { source: "raw_health_measurements" },
		},
	};
}

function calibrationShape(calibration: RunningCalibration | null) {
	if (!calibration) return null;
	return {
		as_of_date: calibration.asOfDate,
		lactate_threshold_hr: calibration.thresholdHr,
		threshold_pace_s_per_km:
			calibration.thresholdSpeedMps && calibration.thresholdSpeedMps > 0
				? round(1000 / calibration.thresholdSpeedMps)
				: null,
		threshold_speed_mps: calibration.thresholdSpeedMps,
		threshold_hr_confidence: calibration.thresholdHrConfidence,
		threshold_pace_confidence: calibration.thresholdSpeedConfidence,
		heart_rate_zones: calibration.heartRateZones,
		pace_zones: calibration.paceZones,
	};
}

function average(values: Array<number | null>): number | null {
	const measured = values.filter((value): value is number => value !== null);
	return measured.length
		? round(
				measured.reduce((sum, value) => sum + value, 0) / measured.length,
				1,
			)
		: null;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> =>
					typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
}

function containsDay(value: Record<string, unknown>, day: string): boolean {
	const start = string(value.start_date);
	const end = string(value.end_date);
	return start !== null && end !== null && start <= day && day <= end;
}

function string(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function activityDay(activity: Activity): string {
	return new Date(activity.date.getTime() + 8 * 3600_000)
		.toISOString()
		.slice(0, 10);
}

function round(value: number, precision = 0): number {
	return Number(value.toFixed(precision));
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength
		? value
		: `${value.slice(0, maxLength)}\n[truncated]`;
}
