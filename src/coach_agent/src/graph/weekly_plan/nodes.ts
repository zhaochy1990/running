import { StateSchema } from "@langchain/langgraph";
import { z } from "zod/v4";
import type { CoachAgentConfig } from "../../config/config.js";
import type {
	WeeklyPlanContext,
	WeeklyPlanContextProvider,
} from "../../persistence/weeklyPlanContextProvider.js";
import { getLogger } from "../../utils/logger.js";
import {
	RecoveryTrendSchema,
	TargetTrainingLoadSchema,
	WeeklyPlanGeneratorContext,
	WeeklyPlanGeneratorOutcome,
	WeeklyPlanGeneratorRequest,
} from "./contracts.js";
import { PHASE_NAMES, PhaseNameSchema } from "../master_plan/schemas.js";

const logger = getLogger("weekly-plan-graph");

export type PhaseName = (typeof PHASE_NAMES)[number];

/** Node names for each canonical phase, keyed by the phase enum value. */
export const PHASE_NODE_NAMES: Record<PhaseName, string> = {
	base: "phase_base",
	build: "phase_build",
	speed: "phase_speed",
	marathon: "phase_marathon",
	taper: "phase_taper",
	recovery: "phase_recovery",
};

/** Resolve the target week's phase from the training position: stage.phase_name takes priority, phase.name is the fallback. */
export function resolvePhaseName(
	weeklyContext: WeeklyPlanContext | undefined,
): PhaseName | null {
	const stage = record(weeklyContext?.training_position.stage);
	const stagePhase = string(stage?.phase_name);
	if (isPhaseName(stagePhase)) return stagePhase;
	const phase = record(weeklyContext?.training_position.phase);
	const phaseName = string(phase?.name);
	if (isPhaseName(phaseName)) return phaseName;
	return null;
}

function isPhaseName(value: string | null): value is PhaseName {
	return value !== null && PHASE_NAMES.includes(value as PhaseName);
}

export const GraphInput = new StateSchema({
	request: WeeklyPlanGeneratorRequest,
});
export const GraphOutput = new StateSchema({
	outcome: WeeklyPlanGeneratorOutcome,
	weekly_context: z.custom<WeeklyPlanContext>().optional(),
	target_training_load: TargetTrainingLoadSchema.optional(),
	phase: PhaseNameSchema.optional(),
});
export const GraphState = new StateSchema({
	request: WeeklyPlanGeneratorRequest,
	context: WeeklyPlanGeneratorContext.optional(),
	weekly_context: z.custom<WeeklyPlanContext>().optional(),
	target_training_load: TargetTrainingLoadSchema.optional(),
	phase: PhaseNameSchema.optional(),
	outcome: WeeklyPlanGeneratorOutcome.optional(),
});

/** Node implementations for the weekly plan generator graph. */
export class WeeklyPlanGeneratorNodes {
	constructor(
		private readonly config: CoachAgentConfig,
		private readonly contextProvider: WeeklyPlanContextProvider,
	) {}

	readonly loadWeeklyPlanContext = async (
		state: typeof GraphState.State,
		runtime: { context?: WeeklyPlanGeneratorContext },
	) => {
		const request = WeeklyPlanGeneratorRequest.parse(state.request);
		const context = WeeklyPlanGeneratorContext.parse(runtime.context);
		try {
			const asOf = request.requested_as_of ?? new Date().toISOString();
			const weeklyContext = await this.contextProvider.loadSnapshot(
				context.userId,
				asOf,
			);
			logger.info(
				`Loaded weekly plan context for user ${context.userId} as of ${asOf}`,
			);
			return { context, weekly_context: weeklyContext };
		} catch (e) {
			logger.error(
				`Failed to load weekly plan context for user ${context.userId}: ${e instanceof Error ? e.message : "unknown error"}`,
			);
			return {
				context,
				outcome: WeeklyPlanGeneratorOutcome.parse({
					decision: "infrastructure_failure",
					request_id: request.request_id,
					generation_id: context.generationId,
					reason: "context_snapshot_unavailable",
				}),
			};
		}
	};

	readonly getTargetTrainingLoad = (state: typeof GraphState.State) => {
		const request = WeeklyPlanGeneratorRequest.parse(state.request);
		const context = WeeklyPlanGeneratorContext.parse(state.context);
		const weeklyContext = state.weekly_context;
		const fitness = record(weeklyContext?.fitness_state);
		const strideLoad = record(fitness?.stride_training_load);
		const loadRatio = number(strideLoad?.load_ratio);
		const form = number(strideLoad?.form);
		const acuteLoad = number(strideLoad?.acute_load);
		const chronicLoad = number(strideLoad?.chronic_load);
		const completeWeeks = (weeklyContext?.recent_training_weeks ?? [])
			.filter((week) => week.complete === true)
			.slice(-4);
		const anchorDose = avg(
			completeWeeks.map((week) => week.actual.total_training_dose),
		);
		const anchorKm = avg(
			completeWeeks.map((week) => week.actual.total_run_distance_km),
		);
		const latestWeek =
			weeklyContext?.absorbed_load.latest_complete_week ?? null;
		const latestWeekDistance =
			latestWeek === null ? null : number(latestWeek.actual_run_distance_km);
		const latestWeekDose =
			latestWeek === null ? null : number(latestWeek.actual_training_dose);
		const highCost = highCostRecentTraining(
			weeklyContext?.absorbed_load.complete_weeks_considered ?? [],
			latestWeekDose,
		);
		const activityRestricted = hasActivityRestriction(
			weeklyContext?.injury ?? [],
		);
		const isRecoveryWeek =
			record(weeklyContext?.training_position.stage)?.is_recovery_week === true;
		const stageTargetKmHigh = number(
			record(weeklyContext?.training_position.stage)?.target_weekly_km_high,
		);
		const recoveryWeekOverridden = recoveryWeekOverriddenByUndeliveredPeak(
			isRecoveryWeek,
			weeklyContext?.recent_training_weeks ?? [],
			latestWeek?.week_start ?? null,
			latestWeekDistance,
			stageTargetKmHigh,
		);
		const recoveryTrend = assessRecoveryTrend(
			weeklyContext?.recovery.history ?? [],
		);
		const latestRecovery = weeklyContext?.recovery.latest ?? null;
		const sevenDayAvg = weeklyContext?.recovery.seven_day_average ?? null;
		const asOfDay = weeklyContext?.as_of.slice(0, 10) ?? null;
		const rhrByDay =
			asOfDay === null
				? {}
				: dailySeries(
						(weeklyContext?.recovery.history ?? []).map((point) => ({
							date: point.date,
							value: point.rhr,
						})),
						asOfDay,
						10,
					);
		const hrvByDay =
			asOfDay === null
				? {}
				: dailySeries(
						(weeklyContext?.recovery.history ?? []).map((point) => ({
							date: point.date,
							value: point.hrv,
						})),
						asOfDay,
						10,
					);

		const rationale: string[] = [];
		if (anchorDose !== null)
			rationale.push(
				`4-week avg training load ${anchorDose} (${completeWeeks.length} complete weeks)`,
			);
		if (anchorKm !== null && latestWeekDistance !== null)
			rationale.push(
				`4-week avg distance ${anchorKm} km vs latest complete week ${latestWeekDistance} km`,
			);
		if (loadRatio !== null)
			rationale.push(`load_ratio ${loadRatio.toFixed(2)}`);
		if (recoveryTrend.available)
			rationale.push(
				`recovery trend: rhr ${recoveryTrend.prior_rhr_avg?.toFixed(1)} -> ${recoveryTrend.recent_rhr_avg?.toFixed(1)}, hrv ${recoveryTrend.prior_hrv_avg?.toFixed(1)} -> ${recoveryTrend.recent_hrv_avg?.toFixed(1)} (${recoveryTrend.window_days}-day window)`,
			);
		if (highCost) rationale.push("recent high-cost training detected");
		if (activityRestricted) rationale.push("activity restricted by injury");
		if (isRecoveryWeek) rationale.push("recovery week marked by master plan");

		const decision = decideTargetLoad({
			anchorKm,
			latestWeekDistance,
			loadRatio,
			form,
			recoveryDeteriorating: recoveryTrend.deteriorating,
			highCost,
			activityRestricted,
			isRecoveryWeek: isRecoveryWeek && !recoveryWeekOverridden,
		});
		for (const line of decision.rationale) rationale.push(line);
		if (recoveryWeekOverridden)
			rationale.push(
				"recovery week overridden: previous week was a planned peak week that was not delivered, so recovery already happened",
			);

		logger.info(
			`Computed target training load for request ${request.request_id}: decision=${decision.decision} low=${decision.lowRatio} high=${decision.highRatio}`,
		);
		const loadLow =
			anchorDose === null ? null : round(anchorDose * decision.lowRatio);
		const loadHigh =
			anchorDose === null ? null : round(anchorDose * decision.highRatio);
		const canProject =
			anchorDose !== null && acuteLoad !== null && chronicLoad !== null;
		return {
			target_training_load: TargetTrainingLoadSchema.parse({
				available: anchorDose !== null,
				missing_reason: anchorDose === null ? "no_complete_week_load" : null,
				load_decision: decision.decision,
				training_load_low: loadLow,
				training_load_high: loadHigh,
				load_ratio_low: canProject
					? projectEndOfWeekLoadRatio(acuteLoad!, chronicLoad!, loadLow!)
					: null,
				load_ratio_high: canProject
					? projectEndOfWeekLoadRatio(acuteLoad!, chronicLoad!, loadHigh!)
					: null,
				remove_quality_stimulus: decision.removeQualityStimulus,
				details: {
					last_complete_week:
						latestWeek === null
							? null
							: {
									week_start: latestWeek.week_start,
									distance_km: latestWeekDistance,
									training_load: latestWeekDose,
								},
					anchor: {
						training_load_avg4w: anchorDose,
						distance_km_avg4w: anchorKm,
					},
					trend: {
						recovery: recoveryTrend.available
							? RecoveryTrendSchema.parse({
									available: true,
									recent_rhr_avg: recoveryTrend.recent_rhr_avg,
									prior_rhr_avg: recoveryTrend.prior_rhr_avg,
									recent_hrv_avg: recoveryTrend.recent_hrv_avg,
									prior_hrv_avg: recoveryTrend.prior_hrv_avg,
									rhr_rising: recoveryTrend.rhr_rising,
									hrv_falling: recoveryTrend.hrv_falling,
									deteriorating: recoveryTrend.deteriorating,
									window_days: recoveryTrend.window_days,
									missing_reason: null,
								})
							: {
									available: false,
									recent_rhr_avg: null,
									prior_rhr_avg: null,
									recent_hrv_avg: null,
									prior_hrv_avg: null,
									rhr_rising: false,
									hrv_falling: false,
									deteriorating: false,
									window_days: 0,
									missing_reason: recoveryTrend.missing_reason,
								},
						rhr: rhrByDay,
						hrv: hrvByDay,
						seven_day_average: {
							rhr: number(sevenDayAvg?.rhr),
							hrv: number(sevenDayAvg?.hrv),
						},
						current_load_ratio: loadRatio,
						form,
						is_recovery_week: isRecoveryWeek,
						recovery_week_overridden: recoveryWeekOverridden,
						activity_restricted: activityRestricted,
						recent_high_cost_training: highCost,
					},
					rationale,
				},
			}),
		};
	};

	readonly routeByPhase = (state: typeof GraphState.State) => {
		const phase = resolvePhaseName(state.weekly_context);
		if (phase === null) {
			logger.error(
				`Cannot resolve target week phase for request ${state.request?.request_id}: no stage.phase_name or phase.name`,
			);
			return "phase_unresolvable";
		}
		return PHASE_NODE_NAMES[phase];
	};

	private readonly phaseNode =
		(phase: PhaseName) => (state: typeof GraphState.State) => {
			logger.info(
				`Routing request ${state.request?.request_id} to ${phase} phase skeleton node`,
			);
			return { phase };
		};

	readonly phaseBase = this.phaseNode("base");
	readonly phaseBuild = this.phaseNode("build");
	readonly phaseSpeed = this.phaseNode("speed");
	readonly phaseMarathon = this.phaseNode("marathon");
	readonly phaseTaper = this.phaseNode("taper");
	readonly phaseRecovery = this.phaseNode("recovery");

	readonly phaseUnresolvable = (state: typeof GraphState.State) => {
		const request = WeeklyPlanGeneratorRequest.parse(state.request);
		const context = WeeklyPlanGeneratorContext.parse(state.context);
		logger.error(
			`No canonical phase for request ${request.request_id}: target week phase is missing or unknown`,
		);
		return {
			outcome: WeeklyPlanGeneratorOutcome.parse({
				decision: "quality_failure",
				request_id: request.request_id,
				generation_id: context.generationId,
				reason: "phase_unresolvable",
			}),
		};
	};

	readonly finalize = (state: typeof GraphState.State) => {
		const request = WeeklyPlanGeneratorRequest.parse(state.request);
		const context = WeeklyPlanGeneratorContext.parse(state.context);
		const targetLoad = state.target_training_load;
		const phase = state.phase;
		if (!targetLoad) {
			throw new Error("target_training_load is missing before finalize");
		}
		if (!phase) {
			throw new Error("phase is missing before finalize");
		}
		logger.info(
			`Finalizing request ${request.request_id} for phase ${phase} with target training load ${JSON.stringify(targetLoad)}`,
		);
		return {
			outcome: WeeklyPlanGeneratorOutcome.parse({
				decision: "completed",
				request_id: request.request_id,
				generation_id: context.generationId,
				phase,
				target_training_load: targetLoad,
			}),
		};
	};
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function string(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number): number {
	return Number(value.toFixed(2));
}

interface RecoveryPoint {
	date: string;
	rhr: number | null;
	hrv: number | null;
}

interface RecoveryTrendAssessment {
	available: boolean;
	missing_reason: string | null;
	recent_rhr_avg: number | null;
	prior_rhr_avg: number | null;
	recent_hrv_avg: number | null;
	prior_hrv_avg: number | null;
	rhr_rising: boolean;
	hrv_falling: boolean;
	deteriorating: boolean;
	window_days: number;
}

const RECOVERY_WINDOW_DAYS = 5;

function assessRecoveryTrend(
	history: RecoveryPoint[],
): RecoveryTrendAssessment {
	const withReadings = history.filter(
		(point) => point.rhr !== null && point.hrv !== null,
	);
	if (withReadings.length < RECOVERY_WINDOW_DAYS * 2) {
		return {
			available: false,
			missing_reason: "insufficient_recovery_history",
			recent_rhr_avg: null,
			prior_rhr_avg: null,
			recent_hrv_avg: null,
			prior_hrv_avg: null,
			rhr_rising: false,
			hrv_falling: false,
			deteriorating: false,
			window_days: 0,
		};
	}
	const prior = withReadings.slice(0, RECOVERY_WINDOW_DAYS);
	const recent = withReadings.slice(-RECOVERY_WINDOW_DAYS);
	const priorRhrAvg = mean(prior.map((point) => point.rhr));
	const recentRhrAvg = mean(recent.map((point) => point.rhr));
	const priorHrvAvg = mean(prior.map((point) => point.hrv));
	const recentHrvAvg = mean(recent.map((point) => point.hrv));
	const rhrRising = recentRhrAvg > priorRhrAvg;
	const hrvFalling = recentHrvAvg < priorHrvAvg;
	return {
		available: true,
		missing_reason: null,
		recent_rhr_avg: round(recentRhrAvg),
		prior_rhr_avg: round(priorRhrAvg),
		recent_hrv_avg: round(recentHrvAvg),
		prior_hrv_avg: round(priorHrvAvg),
		rhr_rising: rhrRising,
		hrv_falling: hrvFalling,
		deteriorating: rhrRising && hrvFalling,
		window_days: RECOVERY_WINDOW_DAYS,
	};
}

function mean(values: Array<number | null>): number {
	const numbers = values.filter((value): value is number => value !== null);
	if (numbers.length === 0) return 0;
	return numbers.reduce((total, value) => total + value, 0) / numbers.length;
}

interface AbsorbedWeek {
	week_start: string;
	actual_run_distance_km: number;
	actual_training_dose: number;
}

function highCostRecentTraining(
	completeWeeks: AbsorbedWeek[],
	latestWeekDose: number | null,
): boolean {
	if (latestWeekDose === null || completeWeeks.length < 2) return false;
	const doses = completeWeeks
		.map((week) => week.actual_training_dose)
		.sort((a, b) => a - b);
	const median = doses[Math.floor(doses.length / 2)] ?? 0;
	return median > 0 && latestWeekDose > median * 1.3;
}

function medianDose(completeWeeks: AbsorbedWeek[]): number | null {
	if (completeWeeks.length === 0) return null;
	const doses = completeWeeks
		.map((week) => week.actual_training_dose)
		.sort((a, b) => a - b);
	return doses[Math.floor(doses.length / 2)] ?? null;
}

function avg(values: Array<number | null>): number | null {
	const numbers = values.filter((value): value is number => value !== null);
	if (numbers.length === 0) return null;
	return round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function dailySeries(
	points: Array<{ date: string; value: number | null }>,
	endDay: string,
	days: number,
): Record<string, number | null> {
	const byDate = new Map(points.map((point) => [point.date, point.value]));
	const series: Record<string, number | null> = {};
	const end = new Date(`${endDay}T00:00:00Z`);
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		const day = new Date(end.getTime() - offset * 86_400_000);
		const key = day.toISOString().slice(0, 10);
		series[key] = byDate.has(key) ? byDate.get(key)! : null;
	}
	return series;
}

function projectEndOfWeekLoadRatio(
	startAcute: number,
	startChronic: number,
	weeklyDose: number,
): number {
	const kAcute = 1 - Math.exp(-1 / 7);
	const kChronic = 1 - Math.exp(-1 / 42);
	let acute = startAcute;
	let chronic = startChronic;
	const dailyDose = weeklyDose / 7;
	for (let day = 0; day < 7; day += 1) {
		acute += kAcute * (dailyDose - acute);
		chronic += kChronic * (dailyDose - chronic);
	}
	return round(acute / chronic);
}

function hasActivityRestriction(
	injuries: Array<{ running_restriction: string }>,
): boolean {
	return injuries.some(
		(injury) =>
			injury.running_restriction !== "" &&
			!/^(none|无|没有|no)$/i.test(injury.running_restriction.trim()),
	);
}

interface RecentTrainingWeekWithPlanned {
	week_start: string;
	complete: boolean;
	planned:
		| {
				available: true;
				total_run_distance_km: number | null;
				run_sessions: unknown[];
		  }
		| { available: false; total_run_distance_km: null; run_sessions: [] };
	actual: { total_run_distance_km: number | null };
}

function recoveryWeekOverriddenByUndeliveredPeak(
	isRecoveryWeek: boolean,
	recentWeeks: RecentTrainingWeekWithPlanned[],
	latestWeekStart: string | null,
	latestWeekDistance: number | null,
	stageTargetKmHigh: number | null,
): boolean {
	if (!isRecoveryWeek || latestWeekStart === null) return false;
	const latestWeek = recentWeeks.find(
		(week) => week.complete === true && week.week_start === latestWeekStart,
	);
	if (
		latestWeek?.planned.available !== true ||
		latestWeek.planned.total_run_distance_km === null ||
		latestWeekDistance === null
	) {
		return false;
	}
	const plannedKm = latestWeek.planned.total_run_distance_km;
	if (stageTargetKmHigh !== null && plannedKm < stageTargetKmHigh) return false;
	return latestWeekDistance < plannedKm * 0.9;
}

interface LoadDecisionInput {
	anchorKm: number | null;
	latestWeekDistance: number | null;
	loadRatio: number | null;
	form: number | null;
	recoveryDeteriorating: boolean;
	highCost: boolean;
	activityRestricted: boolean;
	isRecoveryWeek: boolean;
}

interface LoadDecision {
	decision: "increase" | "maintain" | "decrease" | "recover";
	lowRatio: number;
	highRatio: number;
	removeQualityStimulus: boolean;
	rationale: string[];
}

const RECOVERY_WEEK_MIN_RATIO = 0.7;
const RECOVERY_WEEK_MAINTAIN_RATIO = 0.85;
const RECOVERY_WEEK_MAX_RATIO = 0.95;

function decideTargetLoad(input: LoadDecisionInput): LoadDecision {
	if (input.isRecoveryWeek && input.anchorKm !== null) {
		return decideRecoveryWeekLoad(input);
	}

	if (input.recoveryDeteriorating) {
		return {
			decision: "decrease",
			lowRatio: 0.8,
			highRatio: 0.9,
			removeQualityStimulus: true,
			rationale: ["recovery deterioration is a veto: cut to 80-90% of anchor"],
		};
	}
	if (input.activityRestricted) {
		return {
			decision: "decrease",
			lowRatio: 0.8,
			highRatio: 0.9,
			removeQualityStimulus: true,
			rationale: ["activity restriction: cut to 80-90% of anchor"],
		};
	}
	if (input.loadRatio === null || input.anchorKm === null) {
		return {
			decision: "maintain",
			lowRatio: 1,
			highRatio: 1.08,
			removeQualityStimulus: false,
			rationale: ["load_ratio unavailable: maintain at anchor"],
		};
	}
	if (input.loadRatio > 1.25) {
		return {
			decision: "decrease",
			lowRatio: 0.8,
			highRatio: 0.9,
			removeQualityStimulus: true,
			rationale: ["load_ratio > 1.25: cut to 80-90% of anchor"],
		};
	}
	if (input.loadRatio >= 1.1 || input.highCost) {
		return {
			decision: "maintain",
			lowRatio: 0.95,
			highRatio: 1.03,
			removeQualityStimulus: false,
			rationale: [
				`load_ratio ${input.loadRatio.toFixed(2)}${input.highCost ? " with recent high-cost training" : ""}: hold between -5% and +3%`,
			],
		};
	}
	if (input.loadRatio >= 0.9) {
		return {
			decision: "maintain",
			lowRatio: 1,
			highRatio: 1.08,
			removeQualityStimulus: false,
			rationale: [`load_ratio ${input.loadRatio.toFixed(2)}: maintain to +8%`],
		};
	}
	return {
		decision: "increase",
		lowRatio: 1.05,
		highRatio: 1.1,
		removeQualityStimulus: false,
		rationale: [
			`load_ratio ${input.loadRatio.toFixed(2)}: recovery rebound of 5-10%`,
		],
	};
}

function decideRecoveryWeekLoad(input: LoadDecisionInput): LoadDecision {
	const anchorRatio =
		input.latestWeekDistance !== null && input.anchorKm !== null
			? input.latestWeekDistance / input.anchorKm
			: null;
	const needsDeepCut =
		(anchorRatio !== null && anchorRatio >= 0.9) ||
		input.recoveryDeteriorating ||
		input.highCost;
	if (needsDeepCut) {
		return {
			decision: "recover",
			lowRatio: RECOVERY_WEEK_MIN_RATIO,
			highRatio: 0.8,
			removeQualityStimulus: true,
			rationale: [
				`recovery week: deep cut to 70-80% (latest week ${anchorRatio !== null ? anchorRatio.toFixed(2) : "n/a"} of anchor${input.recoveryDeteriorating ? ", recovery deteriorating" : ""}${input.highCost ? ", high-cost training" : ""})`,
			],
		};
	}
	const canMaintain =
		anchorRatio !== null &&
		anchorRatio < 0.9 &&
		!input.recoveryDeteriorating &&
		(input.loadRatio === null || input.loadRatio <= 1) &&
		(input.form === null || input.form >= 0);
	if (canMaintain) {
		return {
			decision: "maintain",
			lowRatio: RECOVERY_WEEK_MAINTAIN_RATIO,
			highRatio: RECOVERY_WEEK_MAX_RATIO,
			removeQualityStimulus: false,
			rationale: [
				"recovery week: maintain rather than cut (already below anchor, stable recovery)",
			],
		};
	}
	return {
		decision: "recover",
		lowRatio: 0.8,
		highRatio: 0.9,
		removeQualityStimulus: false,
		rationale: ["recovery week: moderate cut to 80-90% of anchor"],
	};
}
