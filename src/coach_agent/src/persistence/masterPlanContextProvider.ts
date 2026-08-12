import {
	ContextSnapshotSchema,
	type ContextSnapshot,
	type MasterPlanContextProvider,
} from "../graph/master_plan/index.js";
import type {
	Activity,
	ActiveMasterPlanMetadata,
	DailyRecovery,
	DailyTrainingLoad,
	PersonalBest,
	RaceEffort,
	RunningCalibration,
	StrideDataStore,
	UserInjury,
	UserProfile,
} from "./dataStore.js";

type ContextStore = Pick<
	StrideDataStore,
	| "getUserProfile"
	| "getUserInjuries"
	| "getActivitiesByDateRange"
	| "getDailyTrainingLoadByDateRange"
	| "getDailyRecoveryByDateRange"
	| "getPersonalBests"
	| "getLatestRunningCalibration"
	| "getRaceHistory"
	| "getActiveMasterPlanMetadata"
>;

export class MySqlMasterPlanContextProvider
	implements MasterPlanContextProvider {
	constructor(private readonly store: ContextStore) { }

	async loadSnapshot(
		userId: string,
		asOf = new Date().toISOString(),
	): Promise<ContextSnapshot> {
		const end = shanghaiDay(asOf);
		// past 2 years
		const macroStart = addDays(end, -730);
		const recentStart = addDays(end, -111);
		const [
			profile,
			injuries,
			activities,
			loads,
			recovery,
			pbs,
			calibration,
			races,
			activePlan,
		] = await Promise.all([
			this.store.getUserProfile(userId),
			this.store.getUserInjuries(userId),
			this.store.getActivitiesByDateRange(userId, macroStart, end),
			this.store.getDailyTrainingLoadByDateRange(userId, recentStart, end),
			this.store.getDailyRecoveryByDateRange(userId, recentStart, end),
			this.store.getPersonalBests(userId),
			this.store.getLatestRunningCalibration(userId),
			this.store.getRaceHistory(userId, { limit: 30 }),
			this.store.getActiveMasterPlanMetadata(userId),
		]);
		if (!profile)
			throw new Error(`required user profile not found for ${userId}`);
		const runs = activities.filter(
			(a) =>
				a.sport?.toLowerCase().startsWith("run") ||
				a.sportName?.toLowerCase().includes("run"),
		);
		return ContextSnapshotSchema.parse({
			user: { id: userId, profile: profileShape(profile) },
			injuries: injuryShape(injuries),
			personal_bests: pbShape(pbs),
			running_calibration: calibrationShape(calibration),
			race_history: raceShape(races),
			macro_history: macroHistory(runs, macroStart, end),
			recent_history: {
				start_date: recentStart,
				end_date: end,
				weeks: weeklyHistory(
					runs.filter((a) => activityDay(a) >= recentStart),
					loads,
					recovery,
					recentStart,
					end,
				),
			},
			fitness_state: fitnessState(loads, end),
			body_composition: {
				weight_kg: profile.weightKg,
				body_fat_pct: null,
				skeletal_muscle_kg: null,
			},
			active_plan: activePlanShape(activePlan),
			current_phase: currentPhase(activePlan, end),
			continuity: continuity(runs, activePlan, end),
			coverage: coverage(
				profile,
				runs,
				loads,
				recovery,
				calibration,
				injuries,
				activePlan,
			),
			as_of: new Date(asOf).toISOString(),
		});
	}
}

const n = (values: Array<number | null>): number | null => {
	const xs = values.filter((x): x is number => x !== null);
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const durationWeightedActivityAverage = (
	activities: Activity[],
	metric: (activity: Activity) => number | null,
): number | null => {
	const measured = activities.filter(
		(activity) => metric(activity) !== null && (activity.durationS ?? 0) > 0,
	);
	const duration = measured.reduce(
		(total, activity) => total + (activity.durationS ?? 0),
		0,
	);
	return duration
		? Math.round(
				measured.reduce(
					(total, activity) =>
						total + (metric(activity) ?? 0) * (activity.durationS ?? 0),
					0,
				) / duration,
			)
		: null;
};
const round = (v: number, p = 1) => Number(v.toFixed(p));
function profileShape(p: UserProfile) {
	return {
		display_name: p.displayName,
		dob: p.dob,
		sex: p.sex,
		height_cm: p.heightCm,
		weight_kg: p.weightKg,
		running_age_range: p.runningAgeRange,
	};
}
function injuryShape(rows: UserInjury[]) {
	return rows.map((injury) => ({
		body_area: injury.description,
		status: `${injury.recoveryStatus}; restriction=${injury.runningRestriction}`,
		occurred_on: null,
		source: "mysql.user_injury",
	}));
}
function pbShape(rows: PersonalBest[]) {
	return rows.map((p) => ({
		distance: p.distance,
		time_sec: p.timeSec,
		achieved_at: p.achievedAt,
		activity_label_id: p.activityLabelId,
	}));
}
function calibrationShape(c: RunningCalibration | null) {
	return (
		c && {
			as_of_date: c.asOfDate,
			threshold_hr: c.thresholdHr,
			threshold_speed_mps: c.thresholdSpeedMps,
			threshold_hr_confidence: c.thresholdHrConfidence,
			threshold_speed_confidence: c.thresholdSpeedConfidence,
			heart_rate_zones: c.heartRateZones,
			pace_zones: c.paceZones,
		}
	);
}
function raceShape(rows: RaceEffort[]) {
	return rows.map(
		({ date, distanceKm, durationMin, avgPaceSKm, avgHr, maxHr, feel }) => ({
			date,
			distance_km: distanceKm,
			duration_min: durationMin,
			avg_pace_s_km: avgPaceSKm,
			avg_hr: avgHr,
			max_hr: maxHr,
			feel,
		}),
	);
}
function activityDay(a: Activity): string {
	return new Date(a.date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
function monday(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	const delta = (d.getUTCDay() + 6) % 7;
	d.setUTCDate(d.getUTCDate() - delta);
	return d.toISOString().slice(0, 10);
}
function weeklyHistory(
	runs: Activity[],
	loads: DailyTrainingLoad[],
	recovery: DailyRecovery[],
	start?: string,
	end?: string,
) {
	const keys = new Set([
		...runs.map((a) => monday(activityDay(a))),
		...loads.map((x) => monday(x.date)),
		...recovery.map((x) => monday(x.date)),
	]);
	if (start && end)
		for (let day = monday(start); day <= monday(end); day = addDays(day, 7))
			keys.add(day);
	return [...keys].sort().map((week) => {
		const acts = runs.filter((a) => monday(activityDay(a)) === week);
		const ls = loads.filter((x) => monday(x.date) === week);
		const rs = recovery.filter((x) => monday(x.date) === week);
		const latest = ls.at(-1);
		return {
			week_start: week,
			distance_km: round(
				acts.reduce((s, a) => s + (a.distanceM ?? 0), 0) / 1000,
			),
			hours: round(acts.reduce((s, a) => s + (a.durationS ?? 0), 0) / 3600, 2),
			avg_pace_s_km: n(acts.map((a) => a.avgPaceSKm)),
			avg_hr: n(acts.map((a) => a.avgHr)),
			run_count: acts.length,
			run_day_count: new Set(acts.map(activityDay)).size,
			long_run_km: acts.length
				? round(Math.max(...acts.map((a) => a.distanceM ?? 0)) / 1000)
				: null,
			speed_session_count: acts.filter((a) =>
				/interval|tempo|threshold|speed/i.test(
					`${a.trainKind ?? ""} ${a.name ?? ""}`,
				),
			).length,
			race_count: acts.filter((a) => /race|比赛|马拉松/i.test(a.name ?? ""))
				.length,
			training_dose: round(ls.reduce((s, x) => s + x.trainingDose, 0)),
			ctl: latest?.chronicLoad ?? null,
			atl: latest?.acuteLoad ?? null,
			form: latest?.form ?? null,
			rhr: n(rs.map((x) => x.rhr)),
			hrv: n(rs.map((x) => x.hrv)),
		};
	});
}
function macroHistory(runs: Activity[], start: string, end: string) {
	const months = new Map<string, Activity[]>();
	for (const a of runs) {
		const key = activityDay(a).slice(0, 7);
		months.set(key, [...(months.get(key) ?? []), a]);
	}
	const weeks = weeklyHistory(runs, [], [], start, end);
	const dates = [...new Set(runs.map(activityDay))].sort();
	const intervals = dates.length
		? [
			[start, dates[0]!],
			...dates.slice(1).map((date, i) => [dates[i]!, date]),
			[dates.at(-1)!, end],
		]
		: [[start, end]];
	const gaps = intervals
		.map(([from, to]) => ({
			start_date: from!,
			end_date: to!,
			days: Math.max(0, dayDiff(from!, to!) - 1),
		}))
		.filter((g) => g.days >= 14);
	const roadRuns = runs.filter(isRoadRun);
	return {
		start_date: start,
		end_date: end,
		months: [...months]
			.sort()
			.map(([month, xs]) => ({
				month,
				distance_km: round(
					xs.reduce((s, a) => s + (a.distanceM ?? 0), 0) / 1000,
				),
				hours: round(xs.reduce((s, a) => s + (a.durationS ?? 0), 0) / 3600, 2),
				avg_pace_s_km: durationWeightedActivityAverage(
					xs,
					(a) => a.avgPaceSKm,
				),
				avg_hr: durationWeightedActivityAverage(xs, (a) => a.avgHr),
				run_count: xs.length,
			})),
		peak_weekly_distance_km: weeks.length
			? Math.max(...weeks.map((w) => w.distance_km))
			: null,
		longest_run_km: runs.length
			? round(Math.max(...runs.map((a) => a.distanceM ?? 0)) / 1000)
			: null,
		longest_road_run_km: roadRuns.length
			? round(Math.max(...roadRuns.map((a) => a.distanceM ?? 0)) / 1000)
			: null,
		gap_periods: gaps,
		consistency_pct: weeks.length
			? round(
				(100 * weeks.filter((w) => w.run_count > 0).length) /
				Math.max(1, Math.ceil(dayDiff(start, end) / 7)),
			)
			: null,
	};
}
function fitnessState(loads: DailyTrainingLoad[], end: string) {
	const x = loads.at(-1);
	return {
		as_of_date: end,
		ctl: x?.chronicLoad ?? null,
		atl: x?.acuteLoad ?? null,
		form: x?.form ?? null,
	};
}
function activePlanShape(p: ActiveMasterPlanMetadata | null) {
	if (!p) return null;
	return {
		plan_id: p.planId,
		revision: p.revision,
		status: p.status,
		start_date: stringOrNull(p.content.start_date),
		end_date: stringOrNull(p.content.end_date),
	};
}
function currentPhase(p: ActiveMasterPlanMetadata | null, day: string) {
	const phases = Array.isArray(p?.content.phases) ? p.content.phases : [];
	const phase = phases.find((value): value is Record<string, unknown> => {
		if (typeof value !== "object" || value === null) return false;
		const candidate = value as Record<string, unknown>;
		const start = stringOrNull(candidate.start_date);
		const end = stringOrNull(candidate.end_date);
		return start !== null && end !== null && start <= day && end >= day;
	});
	return phase
		? {
			name: String(phase.name),
			start_date: stringOrNull(phase.start_date),
			end_date: stringOrNull(phase.end_date),
			source: "active_plan" as const,
		}
		: null;
}
function continuity(
	runs: Activity[],
	p: ActiveMasterPlanMetadata | null,
	end: string,
) {
	const last = runs.map(activityDay).sort().at(-1) ?? null;
	return {
		active_plan_continuation: p !== null,
		last_activity_date: last,
		days_since_last_run: last ? dayDiff(last, end) : null,
	};
}
function coverage(
	p: UserProfile,
	runs: Activity[],
	loads: DailyTrainingLoad[],
	recovery: DailyRecovery[],
	c: RunningCalibration | null,
	injuries: UserInjury[],
	plan: ActiveMasterPlanMetadata | null,
) {
	return [
		{ domain: "profile", status: "complete", detail: null },
		{
			domain: "activities",
			status: runs.length ? "complete" : "missing",
			detail: runs.length ? null : "no runs in lookback",
		},
		{
			domain: "training_load",
			status: loads.length ? "complete" : "missing",
			detail: loads.length ? null : "not computed",
		},
		{
			domain: "recovery",
			status: recovery.length ? "partial" : "missing",
			detail: recovery.length ? "availability varies by day" : "no RHR/HRV",
		},
		{
			domain: "running_calibration",
			status: c ? "complete" : "missing",
			detail: c ? null : "not computed",
		},
		{
			domain: "body_composition",
			status: p.weightKg === null ? "missing" : "partial",
			detail: "no dedicated body-composition table; profile weight only",
		},
		{
			domain: "injuries",
			status: "complete",
			detail: injuries.length ? null : "no recorded injuries",
		},
		{
			domain: "active_plan",
			status: "complete",
			detail: plan
				? null
				: "no active plan, expected for new-season generation",
		},
	] as const;
}
function stringOrNull(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
function dayDiff(a: string, b: string): number {
	return Math.round(
		(Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000,
	);
}
function addDays(day: string, amount: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + amount);
	return d.toISOString().slice(0, 10);
}
function shanghaiDay(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.valueOf())) throw new Error(`invalid asOf: ${iso}`);
	return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
function isRoadRun(run: Activity): boolean {
	const token =
		`${run.sport ?? ""} ${run.sportName ?? ""} ${run.name ?? ""}`.toLowerCase();
	if (/trail|越野|track|场地|treadmill|跑步机|indoor|室内/.test(token))
		return false;
	if (run.sport === "run_outdoor") return true;
	if (run.sport !== null) return false;
	return /outdoor|road|公路|户外/.test(token);
}
