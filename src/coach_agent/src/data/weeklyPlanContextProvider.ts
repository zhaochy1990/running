import {
	addDays,
	mondayOnOrBefore as monday,
	planningStartDate,
	shanghaiDay,
	weekFolder,
} from "@stride/contract";
import { median } from "../utils/statistics.js";
import {
	isQualityRunningActivity,
	isRunningActivity,
} from "./activityClassification.js";
import type {
	ActiveMasterPlanMetadata,
	Activity,
	DailyRecovery,
	DailyTrainingLoad,
	HeartRateZone,
	PaceZone,
	DataProvider,
	RunningCalibration,
	UserInjury,
	UserProfile,
} from "./dataProvider.js";
import {
	createWeeklyFeedbackSource,
	type WeeklyFeedbackRecord,
	type WeeklyFeedbackSource,
} from "./weeklyFeedbackSource.js";

type ContextStore = Pick<
	DataProvider,
	| "getUserProfile"
	| "getMasterPlanMetadataForDate"
	| "getWeeklyPlan"
	| "getActivitiesByDateRange"
	| "getDailyRecoveryByDateRange"
	| "getDailyTrainingLoadByDateRange"
	| "getLatestRunningCalibration"
	| "getUserInjuries"
	| "getWeeklyFeedbackByDateRange"
> &
	Partial<Pick<DataProvider, "getVendorHrvBaseline">>;

export interface WeeklyPlanContextProvider {
	loadSnapshot(userId: string, asOf: string): Promise<WeeklyPlanContext>;
}

interface PlannedRunSessionSummary {
	date: string | null;
	summary: string | null;
	distance_km: number | null;
}

type PlannedWeekSummary =
	| {
			available: false;
			total_run_distance_km: null;
			run_sessions: [];
	  }
	| {
			available: true;
			distance_coverage: "complete" | "partial";
			total_run_distance_km: number | null;
			run_sessions: PlannedRunSessionSummary[];
	  };

interface ActualTrainingWeekSummary {
	total_run_distance_km: number;
	total_training_dose: number;
	run_days: number;
	longest_run: { date: string; distance_km: number } | null;
	quality_stimulus_days: Array<{
		date: string;
		training_types: string[];
		names: string[];
		notes: string[];
		total_distance_km: number;
	}>;
}

export interface RecentTrainingWeek {
	week_start: string;
	week_end: string;
	complete: boolean;
	planned: PlannedWeekSummary;
	actual: ActualTrainingWeekSummary;
}

interface AbsorbedLoadWeek {
	week_start: string;
	actual_run_distance_km: number;
	actual_training_dose: number;
}

export interface AbsorbedLoad {
	complete_weeks_considered: AbsorbedLoadWeek[];
	distance_anchor_km: number | null;
	latest_complete_week: AbsorbedLoadWeek | null;
}

export interface WeeklyUserProfile {
	age: number | null;
	gender: string | null;
	weight_kg: number | null;
	threshold_pace_s_per_km: number | null;
	threshold_speed_mps: number | null;
	lactate_threshold_hr: number | null;
	rhr_baseline: number | null;
	hrv_baseline_low: number | null;
	hrv_baseline_high: number | null;
	heart_rate_zones: HeartRateZone[];
	pace_zones: PaceZone[];
}

export interface FitnessTrendPoint {
	date: string;
	training_dose: number | null;
	acute_load: number | null;
	chronic_load: number | null;
	form: number | null;
	load_ratio: number | null;
	coverage_status: string | null;
	rhr: number | null;
	hrv: number | null;
}

export interface WeeklyFitnessState {
	as_of_date: string;
	stride_training_load: Record<string, unknown>;
	trend: FitnessTrendPoint[];
	provenance: { source: string; vendor_derived: boolean };
}

export interface WeeklyPlanContext {
	as_of: string;
	plan_start: string;
	week_name: string;
	lookback: { start_date: string; end_date: string; days: number };
	user_profile: WeeklyUserProfile;
	training_position: {
		phase: Record<string, unknown> | null;
		stage: Record<string, unknown> | null;
	};
	recent_activities: Array<Record<string, unknown>>;
	recent_training_weeks: RecentTrainingWeek[];
	absorbed_load: AbsorbedLoad;
	recent_feedback: Array<Record<string, unknown>>;
	fitness_state: WeeklyFitnessState;
	injury: Array<{
		description: string;
		recovery_status: string;
		running_restriction: string;
	}>;
	recovery: {
		latest: DailyRecovery | null;
		seven_day_average: { rhr: number | null; hrv: number | null };
		provenance: { source: string };
	};
}

const LOOKBACK_DAYS = 28;

export class DataProviderWeeklyPlanContextProvider
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
		const recentWeekStarts = completedWeekStarts(planStart);
		const earliestWeekStart = recentWeekStarts[0];
		const trainingHistoryStart =
			earliestWeekStart !== undefined && earliestWeekStart < start
				? earliestWeekStart
				: start;
		const [
			profile,
			plan,
			activities,
			feedback,
			loads,
			recovery,
			injuries,
			calibration,
			hrvBaseline,
			...weeklyPlans
		] = await Promise.all([
			this.store.getUserProfile(userId),
			this.store.getMasterPlanMetadataForDate(userId, planStart),
			this.store.getActivitiesByDateRange(userId, trainingHistoryStart, end),
			this.feedbackSource.getByDateRange(userId, feedbackStart, end),
			this.store.getDailyTrainingLoadByDateRange(userId, start, end),
			this.store.getDailyRecoveryByDateRange(userId, start, end),
			this.store.getUserInjuries(userId),
			this.store.getLatestRunningCalibration(userId, end),
			this.store.getVendorHrvBaseline?.(userId, end) ?? Promise.resolve(null),
			...recentWeekStarts.map((weekStart) =>
				this.store.getWeeklyPlan(userId, weekFolder(weekStart)),
			),
		]);

		const recentWeeks = recentTrainingWeeks(
			recentWeekStarts,
			weeklyPlans,
			activities,
			end,
		);
		return {
			as_of: end,
			plan_start: planStart,
			week_name: weekFolder(planStart),
			lookback: { start_date: start, end_date: end, days: LOOKBACK_DAYS },
			user_profile: userProfileShape(profile, calibration, hrvBaseline, end),
			training_position: trainingPosition(plan, planStart),
			recent_activities: activities
				.filter((activity) => activityDay(activity) >= start)
				.map(activityShape),
			recent_training_weeks: recentWeeks,
			absorbed_load: absorbedLoadShape(recentWeeks),
			recent_feedback: feedback.map(feedbackShape),
			fitness_state: fitnessShape(loads, recovery, end),
			injury: injuryShape(injuries),
			recovery: recoveryShape(recovery, end),
		};
	}
}

function absorbedLoadShape(weeks: RecentTrainingWeek[]): AbsorbedLoad {
	const complete = weeks
		.filter((week) => week.complete === true)
		.slice(-3)
		.map((week) => ({
			week_start: week.week_start,
			actual_run_distance_km: week.actual.total_run_distance_km,
			actual_training_dose: week.actual.total_training_dose,
		}));
	const distances = complete.map((week) => week.actual_run_distance_km);
	return {
		complete_weeks_considered: complete,
		distance_anchor_km: median(distances),
		latest_complete_week: complete.at(-1) ?? null,
	};
}

function trainingPosition(plan: ActiveMasterPlanMetadata | null, day: string) {
	if (!plan) return { phase: null, stage: null };
	const phases = records(plan.content.phases);
	const weeks = records(plan.content.weeks);
	const phase = phases.find((candidate) => containsDay(candidate, day));
	const milestones = records(plan.content.milestones);
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
					milestones: milestones
						.filter((milestone) =>
							containsDay(phase, string(milestone.date) ?? ""),
						)
						.map((milestone) => ({
							type: string(milestone.type),
							date: string(milestone.date),
							target: string(milestone.target),
							completed_actual: string(milestone.completed_actual),
						})),
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

function completedWeekStarts(planStart: string): string[] {
	const latest = monday(addDays(planStart, -1));
	return [-21, -14, -7, 0].map((offset) => addDays(latest, offset));
}

function recentTrainingWeeks(
	weekStarts: string[],
	plans: Array<Record<string, unknown> | null>,
	activities: Activity[],
	asOf: string,
): RecentTrainingWeek[] {
	return weekStarts.map((weekStart, index) => {
		const weekEnd = addDays(weekStart, 6);
		const weekActivities = activities.filter((activity) => {
			const day = activityDay(activity);
			return weekStart <= day && day <= weekEnd;
		});
		const runActivities = weekActivities.filter(isRunningActivity);
		const qualityActivities = runActivities.filter(isQualityRunningActivity);
		const runsByDay = groupActivitiesByDay(runActivities);
		const qualityByDay = groupActivitiesByDay(qualityActivities);
		const longestRunDay =
			[...runsByDay.entries()]
				.map(([date, dayActivities]) => ({
					date,
					distance_km: activityDistanceKm(dayActivities),
				}))
				.sort((left, right) => right.distance_km - left.distance_km)[0] ?? null;
		return {
			week_start: weekStart,
			week_end: weekEnd,
			complete: weekEnd <= asOf,
			planned: plannedWeekShape(plans[index] ?? null),
			actual: {
				total_run_distance_km: round(
					runActivities.reduce(
						(sum, activity) => sum + (activity.distanceM ?? 0) / 1000,
						0,
					),
					2,
				),
				total_training_dose: round(
					weekActivities.reduce(
						(sum, activity) => sum + (activity.strideDose ?? 0),
						0,
					),
					2,
				),
				run_days: new Set(runActivities.map(activityDay)).size,
				longest_run: longestRunDay,
				quality_stimulus_days: [...qualityByDay.entries()].map(
					([date, dayActivities]) => ({
						date,
						training_types: unique(
							dayActivities.map((activity) => activity.trainKind),
						),
						names: unique(dayActivities.map((activity) => activity.name)),
						notes: unique(dayActivities.map((activity) => activity.sportNote)),
						total_distance_km: activityDistanceKm(dayActivities),
					}),
				),
			},
		};
	});
}

function plannedWeekShape(
	plan: Record<string, unknown> | null,
): PlannedWeekSummary {
	if (!plan)
		return { available: false, total_run_distance_km: null, run_sessions: [] };
	const runSessions = records(plan.sessions)
		.filter((session) => string(session.kind) === "run")
		.map((session) => {
			const distanceM = number(session.total_distance_m);
			return {
				date: string(session.date),
				summary: string(session.summary),
				distance_km: distanceM === null ? null : round(distanceM / 1000, 2),
			};
		});
	const completeDistance = runSessions.every(
		(session) => session.distance_km !== null,
	);
	return {
		available: true,
		distance_coverage: completeDistance ? "complete" : "partial",
		total_run_distance_km: completeDistance
			? round(
					runSessions.reduce(
						(sum, session) => sum + (session.distance_km ?? 0),
						0,
					),
					2,
				)
			: null,
		run_sessions: runSessions,
	};
}

function groupActivitiesByDay(activities: Activity[]): Map<string, Activity[]> {
	const groups = new Map<string, Activity[]>();
	for (const activity of activities) {
		const day = activityDay(activity);
		groups.set(day, [...(groups.get(day) ?? []), activity]);
	}
	return groups;
}

function activityDistanceKm(activities: Activity[]): number {
	return round(
		activities.reduce(
			(sum, activity) => sum + (activity.distanceM ?? 0) / 1000,
			0,
		),
		2,
	);
}

function unique(values: Array<string | null>): string[] {
	return [
		...new Set(values.filter((value): value is string => value !== null)),
	];
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

function feedbackShape(feedback: WeeklyFeedbackRecord) {
	return {
		week_start: feedback.weekStart,
		content_md: truncate(feedback.contentMd, 12_000),
		updated_at: feedback.updatedAt?.toISOString() ?? null,
	};
}

function fitnessShape(
	loads: DailyTrainingLoad[],
	recovery: DailyRecovery[],
	day: string,
): WeeklyFitnessState {
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
			trend: fitnessTrend(loads, recovery),
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
		trend: fitnessTrend(loads, recovery),
		provenance: { source: "stride", vendor_derived: false },
	};
}

function fitnessTrend(
	loads: DailyTrainingLoad[],
	recovery: DailyRecovery[],
): FitnessTrendPoint[] {
	const loadsByDate = new Map(loads.map((load) => [load.date, load]));
	const recoveryByDate = new Map(recovery.map((point) => [point.date, point]));
	const dates = [...new Set([...loadsByDate.keys(), ...recoveryByDate.keys()])]
		.sort()
		.slice(-14);
	return dates.map((date) => {
		const load = loadsByDate.get(date);
		const point = recoveryByDate.get(date);
		return {
			date,
			training_dose: load?.trainingDose ?? null,
			acute_load: load?.acuteLoad ?? null,
			chronic_load: load?.chronicLoad ?? null,
			form: load?.form ?? null,
			load_ratio: load?.loadRatio ?? null,
			coverage_status: load?.coverageStatus ?? null,
			rhr: point?.rhr ?? null,
			hrv: point?.hrv ?? null,
		};
	});
}

function injuryShape(injuries: UserInjury[]) {
	return injuries.map((injury) => ({
		description: injury.description,
		recovery_status: injury.recoveryStatus,
		running_restriction: injury.runningRestriction,
	}));
}

function recoveryShape(recovery: DailyRecovery[], asOfDay: string) {
	const measured = recovery.filter(
		(row) => row.rhr !== null || row.hrv !== null,
	);
	const latest = measured.at(-1) ?? null;
	const sevenDayStart = addDays(asOfDay, -6);
	const recent = measured.filter(
		(row) => row.date >= sevenDayStart && row.date <= asOfDay,
	);
	return {
		latest,
		seven_day_average: {
			rhr: average(recent.map((row) => row.rhr)),
			hrv: average(recent.map((row) => row.hrv)),
		},
		provenance: { source: "raw_health_measurements" },
	};
}

function userProfileShape(
	profile: UserProfile | null,
	calibration: RunningCalibration | null,
	hrvBaseline: { low: number | null; high: number | null } | null,
	asOfDay: string,
): WeeklyUserProfile {
	return {
		age: ageOn(asOfDay, profile?.dob ?? null),
		gender: profile?.sex ?? null,
		weight_kg: profile?.weightKg ?? null,
		threshold_pace_s_per_km:
			calibration?.thresholdSpeedMps && calibration.thresholdSpeedMps > 0
				? round(1000 / calibration.thresholdSpeedMps)
				: null,
		threshold_speed_mps: calibration?.thresholdSpeedMps ?? null,
		lactate_threshold_hr: calibration?.thresholdHr ?? null,
		rhr_baseline: calibration?.rhrBaseline ?? null,
		hrv_baseline_low: hrvBaseline?.low ?? null,
		hrv_baseline_high: hrvBaseline?.high ?? null,
		heart_rate_zones: calibration?.heartRateZones ?? [],
		pace_zones: calibration?.paceZones ?? [],
	};
}

function ageOn(asOfDay: string, dob: string | null): number | null {
	if (!dob) return null;
	const dobYear = number(Number.parseInt(dob.slice(0, 4), 10));
	if (dobYear === null) return null;
	const asOfYear = Number.parseInt(asOfDay.slice(0, 4), 10);
	const birthdayThisYear = `${asOfYear}-${dob.slice(5)}`;
	return birthdayThisYear <= asOfDay
		? asOfYear - dobYear
		: asOfYear - dobYear - 1;
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
	return shanghaiDay(activity.date.toISOString());
}

function round(value: number, precision = 0): number {
	return Number(value.toFixed(precision));
}

function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength
		? value
		: `${value.slice(0, maxLength)}\n[truncated]`;
}
