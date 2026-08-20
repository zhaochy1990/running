import { z } from "zod/v4";

export const DailySimulationSchema = z.strictObject({
	date: z.iso.date(),
	estimated_dose: z.number().nonnegative().nullable(),
	estimated_dose_low: z.number().nonnegative().nullable(),
	estimated_dose_high: z.number().nonnegative().nullable(),
	end_ctl: z.number().nullable(),
	end_atl: z.number().nullable(),
	end_form: z.number().nullable(),
	load_ratio: z.number().nonnegative().nullable(),
});

export const SessionSimulationSchema = z.strictObject({
	date: z.iso.date(),
	session_index: z.int().nonnegative(),
	summary: z.string(),
	estimated_dose: z.number().nonnegative().nullable(),
	estimated_dose_low: z.number().nonnegative().nullable(),
	estimated_dose_high: z.number().nonnegative().nullable(),
	declared_distance_km: z.number().nonnegative().nullable(),
	estimated_structured_distance_km: z.number().nonnegative().nullable(),
	load_assumptions: z.array(z.string()),
	missing_dose_reason: z.string().nullable(),
});

export const WeeklyPlanSimulationReportSchema = z.strictObject({
	algorithm_version: z.literal("weekly-plan-load-v1"),
	estimated: z.literal(true),
	provenance: z.string(),
	available: z.boolean(),
	week_start: z.iso.date(),
	initial_pmc_date: z.iso.date(),
	total_dose: z.number().nonnegative().nullable(),
	total_dose_low: z.number().nonnegative().nullable(),
	total_dose_high: z.number().nonnegative().nullable(),
	maximum_session_dose_share: z.number().min(0).max(1).nullable(),
	sessions: z.array(SessionSimulationSchema),
	days: z.array(DailySimulationSchema).length(7),
	load_assumptions: z.array(z.string()),
	missing_dose_reasons: z.array(z.string()),
	safety_issues: z.array(z.string()),
});

export type WeeklyPlanSimulationReport = z.infer<
	typeof WeeklyPlanSimulationReportSchema
>;
