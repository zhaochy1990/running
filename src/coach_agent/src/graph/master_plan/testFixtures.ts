export function createTestRequest() {
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

export function createTestMasterPlan() {
	return {
		status: "draft" as const,
		goal: {
			race_name: "西安马拉松",
			distance: "FM" as const,
			race_date: "2026-10-18",
			target_time: "2:50:00",
			timezone: "Asia/Shanghai" as const,
			location: "西安",
		},
		start_date: "2026-08-10",
		end_date: "2026-08-23",
		total_weeks: 2,
		phases: [
			{
				name: "基础期" as const,
				start_date: "2026-08-10",
				end_date: "2026-08-16",
				focus: "建立赛季起点",
				weekly_distance_km_low: 70,
				weekly_distance_km_high: 80,
				key_session_types: ["long_run"],
				milestones: [],
				key_workouts: "周末长跑",
				monitoring_triggers: ["疼痛加重时降量"],
				coach_note: "保持恢复",
				strength: {
					sessions_per_week: 2,
					focus: "核心和下肢耐力",
					timing: "轻松跑后",
				},
				recovery: {
					focus: "睡眠和补给",
					sleep_target_hours: "7-9",
					adjustment_trigger: "疼痛或睡眠恶化",
				},
				is_completed: false,
				summary: null,
			},
			{
				name: "赛前减量期" as const,
				start_date: "2026-08-17",
				end_date: "2026-08-23",
				focus: "目标比赛",
				weekly_distance_km_low: 42.195,
				weekly_distance_km_high: 50,
				key_session_types: ["race"],
				milestones: [
					{
						type: "race" as const,
						date: "2026-08-23",
						target: "测试比赛",
						completed_actual: null,
					},
				],
				key_workouts: "目标比赛",
				monitoring_triggers: ["异常时停止"],
				coach_note: "比赛周",
				strength: { sessions_per_week: 0, focus: "无", timing: "无" },
				recovery: {
					focus: "恢复",
					sleep_target_hours: "7-9",
					adjustment_trigger: "疼痛",
				},
				is_completed: false,
				summary: null,
			},
		],
		weeks: [
			{
				week_index: 1,
				week_start: "2026-08-10",
				phase_name: "基础期" as const,
				target_weekly_km_low: 70,
				target_weekly_km_high: 80,
				key_sessions: [
					{
						type: "long_run" as const,
						distance_km: 24,
						duration_min: null,
						intensity: "Z2 endurance",
						purpose: "建立耐力",
					},
				],
				is_recovery_week: false,
			},
			{
				week_index: 2,
				week_start: "2026-08-17",
				phase_name: "赛前减量期" as const,
				target_weekly_km_low: 42.195,
				target_weekly_km_high: 50,
				key_sessions: [
					{
						type: "race" as const,
						distance_km: 42.195,
						duration_min: 170,
						intensity: "目标比赛",
						purpose: "完成目标比赛",
					},
				],
				is_recovery_week: false,
			},
		],
		training_principles: ["循序渐进", "长跑练习碳水、液体与电解质补给"],
		generated_by: "coach_agent" as const,
		version: 1 as const,
		created_at: "2026-08-10T00:00:00Z",
		updated_at: "2026-08-10T00:00:00Z",
	};
}

export function createAssessmentSnapshot() {
	return {
		schema_version: 1 as const,
		user: {
			id: "athlete-344",
			profile: {
				display_name: null,
				dob: null,
				sex: null,
				height_cm: null,
				weight_kg: 70,
				running_age_range: null,
			},
		},
		injuries: [],
		personal_bests: [
			{
				distance: "FM",
				time_sec: 10631,
				achieved_at: "2026-03-01",
				source: "race_result",
			},
		],
		running_calibration: {
			as_of_date: "2026-08-10",
			threshold_hr: 172,
			threshold_speed_mps: 4.25,
			threshold_hr_confidence: "high",
			threshold_speed_confidence: "high",
			heart_rate_zones: [],
			pace_zones: [],
		},
		race_history: [],
		macro_history: {
			start_date: "2024-08-10",
			end_date: "2026-08-10",
			months: [],
			peak_weekly_distance_km: 92,
			longest_run_km: 32,
			longest_road_run_km: 32,
			gap_periods: [
				{ start_date: "2025-01-01", end_date: "2025-01-18", days: 18 },
			],
			consistency_pct: 84,
		},
		recent_history: {
			start_date: "2026-06-15",
			end_date: "2026-08-10",
			weeks: [
				{
					week_start: "2026-06-15",
					distance_km: 58,
					hours: 5,
					avg_pace_s_km: 310,
					avg_hr: 140,
					run_count: 5,
					run_day_count: 5,
					long_run_km: 20,
					speed_session_count: 1,
					race_count: 0,
					training_dose: 400,
					ctl: 61,
					atl: 62,
					form: -1,
					rhr: 48,
					hrv: 58,
				},
				{
					week_start: "2026-06-22",
					distance_km: 62,
					hours: 5.4,
					avg_pace_s_km: 308,
					avg_hr: 141,
					run_count: 5,
					run_day_count: 5,
					long_run_km: 22,
					speed_session_count: 1,
					race_count: 0,
					training_dose: 430,
					ctl: 63,
					atl: 65,
					form: -2,
					rhr: 48,
					hrv: 57,
				},
				{
					week_start: "2026-06-29",
					distance_km: 66,
					hours: 5.7,
					avg_pace_s_km: 306,
					avg_hr: 141,
					run_count: 6,
					run_day_count: 6,
					long_run_km: 24,
					speed_session_count: 2,
					race_count: 0,
					training_dose: 450,
					ctl: 65,
					atl: 68,
					form: -3,
					rhr: 49,
					hrv: 55,
				},
				{
					week_start: "2026-07-06",
					distance_km: 70,
					hours: 6,
					avg_pace_s_km: 305,
					avg_hr: 142,
					run_count: 6,
					run_day_count: 6,
					long_run_km: 26,
					speed_session_count: 2,
					race_count: 0,
					training_dose: 470,
					ctl: 66,
					atl: 70,
					form: -4,
					rhr: 49,
					hrv: 54,
				},
				{
					week_start: "2026-07-13",
					distance_km: 68,
					hours: 5.9,
					avg_pace_s_km: 306,
					avg_hr: 141,
					run_count: 5,
					run_day_count: 5,
					long_run_km: 24,
					speed_session_count: 1,
					race_count: 0,
					training_dose: 460,
					ctl: 66,
					atl: 69,
					form: -3,
					rhr: 48,
					hrv: 56,
				},
				{
					week_start: "2026-07-20",
					distance_km: 72,
					hours: 6.2,
					avg_pace_s_km: 304,
					avg_hr: 142,
					run_count: 6,
					run_day_count: 6,
					long_run_km: 26,
					speed_session_count: 2,
					race_count: 0,
					training_dose: 485,
					ctl: 67,
					atl: 72,
					form: -5,
					rhr: 49,
					hrv: 54,
				},
				{
					week_start: "2026-07-27",
					distance_km: 74,
					hours: 6.3,
					avg_pace_s_km: 303,
					avg_hr: 142,
					run_count: 6,
					run_day_count: 6,
					long_run_km: 28,
					speed_session_count: 2,
					race_count: 0,
					training_dose: 500,
					ctl: 68,
					atl: 75,
					form: -7,
					rhr: 49,
					hrv: 53,
				},
				{
					week_start: "2026-08-03",
					distance_km: 64,
					hours: 5.5,
					avg_pace_s_km: 309,
					avg_hr: 140,
					run_count: 5,
					run_day_count: 5,
					long_run_km: 22,
					speed_session_count: 1,
					race_count: 0,
					training_dose: 420,
					ctl: 68,
					atl: 74,
					form: -6,
					rhr: 48,
					hrv: 56,
				},
			],
		},
		fitness_state: { as_of_date: "2026-08-10", ctl: 68, atl: 74, form: -6 },
		body_composition: {
			weight_kg: 70,
			body_fat_pct: 14,
			skeletal_muscle_kg: 34,
		},
		active_plan: null,
		current_phase: null,
		continuity: {
			active_plan_continuation: false,
			last_activity_date: "2026-08-09",
			days_since_last_run: 1,
		},
		coverage: [
			{ domain: "activities", status: "complete" as const, detail: null },
			{ domain: "training_load", status: "complete" as const, detail: null },
			{ domain: "personal_bests", status: "complete" as const, detail: null },
			{
				domain: "injuries",
				status: "missing" as const,
				detail: "no canonical records",
			},
		],
		source_manifest: [],
		as_of: "2026-08-10T00:00:00Z",
	};
}

export function createTestAthleteAssessment() {
	return {
		schema_version: 1 as const,
		readiness: "limited" as const,
		summary: "Ready with limited runway",
		safe_training_ranges: {
			weekly_distance_km: { low: 55, high: 80 },
			runs_per_week: { low: 4, high: 6 },
			long_run_km: { low: 18, high: 30 },
			quality_sessions_per_week: { low: 1, high: 2 },
		},
		material_conclusions: [
			{
				claim: "volume_baseline_established" as const,
				explanation: "Recent volume supports preparation",
				fact_ids: ["volume.recent_weekly_km"],
			},
		],
		gaps: [],
	};
}

export function createTestGoalAssessment() {
	const conditions = (fact_id: string) => [
		{ description: "Evidence gate", fact_ids: [fact_id] },
	];
	return {
		schema_version: 1 as const,
		level: "aggressive_but_plausible" as const,
		summary: "Aggressive but plausible goal",
		material_conclusions: [
			{
				claim: "goal_requires_improvement" as const,
				explanation: "Goal requires improvement",
				fact_ids: ["goal.a.improvement_pct"],
			},
		],
		abc_gates: {
			A: {
				target: {
					kind: "time" as const,
					time_seconds: 10200,
					label: "2:50:00",
				},
				conditions: conditions("goal.a.improvement_pct"),
			},
			B: {
				target: {
					kind: "time" as const,
					time_seconds: 10380,
					label: "2:53:00",
				},
				conditions: conditions("goal.a.matching_pb_seconds"),
			},
			C: {
				target: {
					kind: "finish" as const,
					time_seconds: null,
					label: "Safe completion",
				},
				conditions: conditions("load.current_form"),
			},
		},
		conflicts: [],
		multi_cycle_path: [],
	};
}

export function createTestStrategyCandidate(
	archetype: "conservative" | "balanced" | "aggressive_gated" = "balanced",
) {
	const loadHigh =
		archetype === "conservative" ? 70 : archetype === "balanced" ? 75 : 80;
	const longRun =
		archetype === "conservative" ? 24 : archetype === "balanced" ? 27 : 30;
	return {
		schema_version: 1 as const,
		candidate_id: `strategy-${archetype.replace("_", "-")}-v1`,
		archetype,
		phases: [
			{
				name: "基础",
				weeks: 1,
				focus: "巩固容量",
				weekly_km_low: 60,
				weekly_km_high: loadHigh,
			},
			{
				name: "比赛",
				weeks: 1,
				focus: "目标比赛",
				weekly_km_low: 42.195,
				weekly_km_high: 50,
			},
		],
		weekly_highs_km: [loadHigh, 50],
		max_long_run_km: longRun,
		max_quality_sessions_per_week: 2,
		race_week_index: 2,
		load_curve: `${archetype} load curve`,
		recovery_cadence: "3:1",
		specific_progression: ["MP 8→12→16→20km"],
		milestones: ["半马检验A目标门槛"],
		taper: "两周减量",
		strength: "每周两次下肢耐力",
		nutrition: "长跑补给演练",
		risk_tradeoffs: [`${archetype}风险收益`],
		hard_constraints_satisfied: true,
		hard_constraint_violations: [] as string[],
		evidence_fact_ids: ["volume.recent_weekly_km"],
	};
}

export function createTestJudgments(
	candidateId: string,
	scores: [number, number, number] = [4, 4, 4],
) {
	return (
		["performance_path", "safety_load", "constraint_feasibility"] as const
	).map((judge, index) => ({
		schema_version: 1 as const,
		judge,
		candidate_id: candidateId,
		score: scores[index]!,
		veto: false,
		rationale: `${judge} rationale`,
		evidence_fact_ids: ["volume.recent_weekly_km"],
	}));
}

export function createTestReviewReport(
	reviewerType: "periodization" | "load_progression" | "constraint_grounding",
	overrides: Record<string, unknown> = {},
) {
	const scores =
		reviewerType === "periodization"
			? {
					season_structure: 5,
					peak_timing: 5,
					recovery_absorption: 5,
					taper_quality: 5,
				}
			: reviewerType === "load_progression"
				? {
						volume_progression: 5,
						dose_trajectory: 5,
						hard_stimulus_density: 5,
						long_run_concentration: 5,
					}
				: {
						goal_fidelity: 5,
						availability_fit: 5,
						evidence_grounding: 5,
						selected_strategy_fidelity: 5,
					};
	return {
		review_task_id: `master-plan:r1:${reviewerType}:rubric-v1:prompt-v1`,
		reviewer_type: reviewerType,
		artifact_revision: 1,
		rubric_version: "rubric-v1",
		prompt_version: "prompt-v1",
		verdict: "pass" as const,
		scores,
		evidence_refs: ["fact:volume.recent_weekly_km"],
		issues: [],
		rationale: `${reviewerType} passed`,
		confidence: 0.9,
		...overrides,
	};
}
