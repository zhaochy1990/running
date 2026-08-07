/**
 * S1 master-plan generation — `load_context` node (SCAFFOLD / MOCK).
 *
 * TS port skeleton of the Python `load_master_context`
 * (`stride_server/coach_adapters/master_plan_adapter.py:195`). This is the FIRST
 * node of the generation graph:
 *
 *     load_context → generator → rule_filter → reviewer → verdict → finalize
 *
 * Responsibility: read the athlete's training signals and assemble a
 * `MasterPlanContext` for the generator prompt.
 *
 * Unlike the Python version, the TS port has no async-job layer — there are no
 * stage-update / progress side effects here; the node just returns the context.
 *
 * ⚠️ This file is a FRAMEWORK ONLY. Every helper below returns hardcoded mock
 * data — no DB, no calibration, no real queries yet. The point is to lock in the
 * node's shape (inputs, output context, call sequence) so the real
 * implementations can be dropped in one helper at a time.
 *
 * Type declarations live next to this file in `./types.ts`.
 */

import type { GraphNode } from "@langchain/langgraph";
import { getLogger } from "../../logging/index.js";
import type { AgentsState } from "../state.js";
import type {
  AthleteProfile,
  BodyComposition,
  Continuity,
  CurrentPhase,
  FitnessState,
  MasterPlanContext,
  MasterPlanGoal,
  TrainingHistory,
} from "./types.js";

const logger = getLogger("generation.load_context");

// ---------------------------------------------------------------------------
// "today" helpers
// ---------------------------------------------------------------------------

/** MOCK — real impl uses the Shanghai timezone helper. */
function todayShanghai(): string {
  return "2026-07-28";
}

/** Resolve the as-of date: explicit `goal.as_of_date` (replay) else today. */
function resolveAsOf(goal: MasterPlanGoal): string {
  return goal.as_of_date ?? todayShanghai();
}

// ---------------------------------------------------------------------------
// Mock data-loading helpers (one per Python sub-function).
// Each returns HARDCODED mock content — no DB access yet.
// ---------------------------------------------------------------------------

/** MOCK of `_query_history`. */
function queryHistory(_userId: string, _asOf: string): TrainingHistory {
  return {
    total_activities: 312,
    max_weekly_km: 78.4,
    monthly_km: { "2026-05": 268.1, "2026-06": 291.4, "2026-07": 240.0 },
    weekly_profile: [
      { week_start: "2026-07-06", distance_km: 62.3, avg_hr: 148, rhr: 46 },
      { week_start: "2026-07-13", distance_km: 71.0, avg_hr: 151, rhr: 45 },
      { week_start: "2026-07-20", distance_km: 58.5, avg_hr: 146, rhr: 47 },
    ],
  };
}

/** MOCK of `_query_fitness_state`. */
function queryFitnessState(_userId: string, _asOf: string): FitnessState {
  return {
    chronic_load: 68.2,
    acute_load: 61.5,
    form: 6.7,
    rhr: 46,
    hrv: 72,
    summary: "CTL 68 / ATL 62 / form +6.7（维持期偏比赛就绪），RHR 46，HRV 72（平稳）。",
  };
}

/** MOCK of `_load_pb_seconds`. */
function loadPbSeconds(_userId: string): Record<string, number> {
  return { "5k": 1146, "10k": 2388, hm: 5322, fm: 11460 };
}

/** MOCK of `analyze_continuity`. */
function analyzeContinuity(
  _goal: MasterPlanGoal,
  _profile: AthleteProfile | null,
  _asOf: string,
): Continuity | null {
  return {
    macro_cycle: "summer",
    recent_aerobic_weeks: 9,
    current_form_zone: "race_ready",
    current_chronic_load: 68.2,
    recent_longest_run_km: 30.0,
    days_since_last_race: 84,
    return_from_layoff: false,
    injuries: [],
  };
}

/** MOCK of `detect_current_phase`. */
function detectCurrentPhase(
  _goal: MasterPlanGoal,
  _profile: AthleteProfile | null,
  _asOf: string,
): CurrentPhase | null {
  return {
    source: "inferred",
    current_phase_type: "base",
    recommended_entry_phase: "build",
    weeks_in_phase: 4,
    completed_aerobic_weeks: 9,
    confidence: 0.72,
    rationale: "近 9 周稳定有氧积累、周量 58-71km，判定基础期后段，建议从进展期切入。",
  };
}

/** MOCK of `_load_body_composition`. */
function loadBodyComposition(_userId: string, _profile: AthleteProfile | null): BodyComposition | null {
  return {
    scan_date: "2026-07-21",
    weight_kg: 63.5,
    body_fat_pct: 12.4,
    smm_kg: 31.8,
    fat_mass_kg: 7.9,
    bmr_kcal: 1520,
    bmi: 20.7,
  };
}

/** MOCK of `_format_body_composition_summary`. */
function formatBodyCompositionSummary(bc: BodyComposition): string {
  return `最新体测（${bc.scan_date}）— 体重 ${bc.weight_kg}kg，体脂 ${bc.body_fat_pct}%，骨骼肌 ${bc.smm_kg}kg，BMI ${bc.bmi}`;
}

/** MOCK of `EstimateMasterPlanLoadImpl` history anchor. */
function estimateTrainingLoadAnchor(
  _userId: string,
  _asOf: string,
): { trainingLoadTool: Record<string, unknown>; trainingLoadToolSummary: string } {
  return {
    trainingLoadTool: {
      history_anchor: { chronic_load: 68.2, weekly_dose_avg: 470, weeks: 12 },
    },
    trainingLoadToolSummary:
      "训练负荷锚点：近 12 周平均周 dose ≈ 470，chronic ≈ 68；维持需周 dose ≈ 476，推进提升期需 ≥ 540。",
  };
}

/** MOCK of `_format_history_summary`. */
function formatHistorySummary(history: TrainingHistory): string {
  return [
    `近 3 个月周量区间 58-78km（峰值 ${history.max_weekly_km}km），共 ${history.total_activities} 次活动。`,
    "PB：5K 19:06 / 10K 39:48 / HM 1:28:42 / FM 3:11:00。",
    "长跑最长 30km，MP 配速课近 6 周有出现。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Node entry point
// ---------------------------------------------------------------------------

/**
 * `load_context` node — assemble the `MasterPlanContext` (SCAFFOLD).
 *
 * Reads history → fitness + continuity + phase + body-comp + PBs, then returns a
 * partial `AgentsState` update `{ context }`. Every value is mock.
 */
export const loadMasterPlanContext: GraphNode<typeof AgentsState> = async (state) => {
  const userId = state.userId;
  const payload = state.inputPayload;
  if (payload == null) {
    throw new Error("loadMasterPlanContext: inputPayload is required for master-plan generation");
  }
  const goal = payload.goal;
  const profile = payload.profile;
  const asOf = resolveAsOf(goal);

  const history = queryHistory(userId, asOf);
  const fitnessState = queryFitnessState(userId, asOf);
  const pbSeconds = loadPbSeconds(userId);
  const continuity = analyzeContinuity(goal, profile, asOf);
  const currentPhase = detectCurrentPhase(goal, profile, asOf);
  const bodyComposition = loadBodyComposition(userId, profile);

  const { trainingLoadTool, trainingLoadToolSummary } = estimateTrainingLoadAnchor(userId, asOf);
  const historySummary = `${formatHistorySummary(history)}\n${trainingLoadToolSummary}`;

  const context: MasterPlanContext = {
    history_summary: historySummary,
    pb_seconds: pbSeconds,
    fitness_state: fitnessState,
    as_of_date: asOf,
    training_load_tool: trainingLoadTool,
    training_load_tool_summary: trainingLoadToolSummary,
    continuity,
    current_phase: currentPhase,
    body_composition: bodyComposition,
    body_composition_summary:
      bodyComposition !== null ? formatBodyCompositionSummary(bodyComposition) : null,
  };

  logger.debug(
    {
      userId,
      historyChars: historySummary.length,
      weeklyProfileWeeks: history.weekly_profile.length,
      pbKeys: Object.keys(pbSeconds),
    },
    "load_master_plan_context assembled (mock)",
  );

  return { context };
}
