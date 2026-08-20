export interface PlannedRunWorkout {
	blocks: ReadonlyArray<{
		repeat: number;
		steps: ReadonlyArray<{
			step_kind: "warmup" | "work" | "recovery" | "cooldown" | "rest";
			duration: {
				kind: "distance_m" | "time_s" | "open";
				value: number | null;
			};
			target: {
				kind: "pace_s_km" | "hr_bpm" | "power_w" | "open";
				low: number | null;
				high: number | null;
			};
		}>;
	}>;
}

export interface PlannedRunLoadEstimate {
	expectedDose: number;
	lowDose: number;
	highDose: number;
	estimatedDistanceKm: number;
	estimatedDurationMin: number;
	assumptions: string[];
	unestimatedSteps: number;
}

type Step = PlannedRunWorkout["blocks"][number]["steps"][number];
type IntensityTriple = {
	low: number;
	expected: number;
	high: number;
	assumption?: string;
};
type Dwell = readonly [minutes: number, intensity: number];

const OPEN_STEP_IF = {
	warmup: 0.78,
	work: 0.85,
	recovery: 0.65,
	cooldown: 0.78,
} as const;
const NORMALIZATION_EXPONENT = 6;

/** Estimate one canonical run-workout/v1 on STRIDE's planned TSS scale. */
export function estimatePlannedRunLoad(
	workout: PlannedRunWorkout,
	thresholdSpeedMps: number,
	thresholdHr?: number | null,
	rhr?: number | null,
): PlannedRunLoadEstimate | null {
	if (!Number.isFinite(thresholdSpeedMps) || thresholdSpeedMps <= 0)
		return null;
	const lowDwells: Dwell[] = [];
	const expectedDwells: Dwell[] = [];
	const highDwells: Dwell[] = [];
	let estimatedDistanceKm = 0;
	let estimatedDurationMin = 0;
	let estimatedSteps = 0;
	let unestimatedSteps = 0;
	const assumptions: string[] = [];

	for (const block of workout.blocks)
		for (let repetition = 0; repetition < block.repeat; repetition += 1)
			for (const step of block.steps) {
				if (step.step_kind === "rest") continue;
				const intensity = stepIntensity(
					step,
					thresholdSpeedMps,
					thresholdHr,
					rhr,
				);
				if (!intensity) {
					unestimatedSteps += 1;
					continue;
				}
				const minutes = stepMinutes(
					step,
					intensity.expected,
					thresholdSpeedMps,
				);
				if (!minutes) {
					unestimatedSteps += 1;
					continue;
				}

				estimatedSteps += 1;
				estimatedDurationMin += minutes;
				let lowMinutes = minutes;
				let highMinutes = minutes;
				if (step.duration.kind === "distance_m") {
					estimatedDistanceKm += (step.duration.value ?? 0) / 1000;
					lowMinutes =
						stepMinutes(step, intensity.low, thresholdSpeedMps) ?? minutes;
					highMinutes =
						stepMinutes(step, intensity.high, thresholdSpeedMps) ?? minutes;
				} else {
					estimatedDistanceKm +=
						(minutes * 60 * thresholdSpeedMps * intensity.expected) / 1000;
				}
				lowDwells.push([lowMinutes, intensity.low]);
				expectedDwells.push([minutes, intensity.expected]);
				highDwells.push([highMinutes, intensity.high]);
				if (intensity.assumption) assumptions.push(intensity.assumption);
			}

	if (estimatedSteps === 0) return null;
	const lowDose = doseFromDwells(lowDwells);
	const expectedDose = doseFromDwells(expectedDwells);
	const highDose = doseFromDwells(highDwells);
	if (lowDose === null || expectedDose === null || highDose === null)
		return null;
	return {
		lowDose,
		expectedDose,
		highDose,
		estimatedDistanceKm,
		estimatedDurationMin,
		assumptions: [...new Set(assumptions)],
		unestimatedSteps,
	};
}

function stepIntensity(
	step: Step,
	thresholdSpeedMps: number,
	thresholdHr?: number | null,
	rhr?: number | null,
): IntensityTriple | null {
	const target = step.target;
	if (
		target.kind === "pace_s_km" &&
		target.low !== null &&
		target.high !== null &&
		target.low > 0 &&
		target.high > 0
	) {
		const slowPace = Math.max(target.low, target.high);
		const fastPace = Math.min(target.low, target.high);
		const low = clamp(1000 / slowPace / thresholdSpeedMps, 0, 2);
		const high = clamp(1000 / fastPace / thresholdSpeedMps, 0, 2);
		return { low, expected: (low + high) / 2, high };
	}
	if (
		target.kind === "hr_bpm" &&
		target.low !== null &&
		target.high !== null &&
		target.low > 0 &&
		target.high > 0
	) {
		if (!thresholdHr || rhr === null || rhr === undefined || thresholdHr <= rhr)
			return null;
		const lowHr = Math.min(target.low, target.high);
		const highHr = Math.max(target.low, target.high);
		const low = clamp((lowHr - rhr) / (thresholdHr - rhr), 0, 2);
		const high = clamp((highHr - rhr) / (thresholdHr - rhr), 0, 2);
		return {
			low,
			expected: (low + high) / 2,
			high,
			assumption: "heart_rate_target_used_as_intensity_proxy",
		};
	}
	const defaultIf = OPEN_STEP_IF[step.step_kind as keyof typeof OPEN_STEP_IF];
	return defaultIf
		? {
				low: defaultIf,
				expected: defaultIf,
				high: defaultIf,
				assumption: `open_${step.step_kind}_target_if_${defaultIf.toFixed(2)}`,
			}
		: null;
}

function stepMinutes(
	step: Step,
	intensity: number,
	thresholdSpeedMps: number,
): number | null {
	const value = step.duration.value;
	if (value === null || value <= 0) return null;
	if (step.duration.kind === "time_s") return value / 60;
	if (step.duration.kind === "distance_m") {
		const speed = thresholdSpeedMps * intensity;
		return speed > 0 ? value / speed / 60 : null;
	}
	return null;
}

function doseFromDwells(dwells: readonly Dwell[]): number | null {
	const totalMinutes = dwells.reduce((sum, [minutes]) => sum + minutes, 0);
	if (totalMinutes <= 0) return null;
	const weighted = dwells.reduce(
		(sum, [minutes, intensity]) =>
			sum + minutes * intensity ** NORMALIZATION_EXPONENT,
		0,
	);
	const normalizedIf =
		(weighted / totalMinutes) ** (1 / NORMALIZATION_EXPONENT);
	return (100 * totalMinutes * normalizedIf ** 2) / 60;
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}
