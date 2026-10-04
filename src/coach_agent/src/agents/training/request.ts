import type { MasterPlanGraphRequest } from "@stride/contract";
import type { RaceTarget } from "../../data/dataProvider.js";

/**
 * Build a chat-side master-plan kernel request from the athlete's active race
 * goal. The tracer-bullet contract (#427): the info-complete scenario maps the
 * goal 1:1 into `requested_mode: "new_season"` with all confirmations true —
 * the intake questionnaire flow (#431) replaces this once it lands.
 */

/** Why a request could not be built — each kind has its own athlete-facing copy. */
export type MasterPlanRequestGap = { kind: "no_race_goal" } | { kind: "unsupported_distance"; distance: string } | { kind: "invalid_goal"; reason: string };

export type MasterPlanRequestResult = { ok: true; request: MasterPlanGraphRequest } | { ok: false; gap: MasterPlanRequestGap };

/** The literal-true confirmations the kernel request schema requires. */
const CONFIRMED_INTAKE = {
  intake_complete: true,
  goals_confirmed: true,
  availability_confirmed: true,
  injury_history_confirmed: true,
  constraints_confirmed: true,
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RACE_TIME = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/;

export function buildMasterPlanRequest(target: RaceTarget | null, options: { requestId: string; now: Date }): MasterPlanRequestResult {
  if (target === null) {
    return { ok: false, gap: { kind: "no_race_goal" } };
  }
  if (target.race_distance !== "FM" && target.race_distance !== "HM") {
    return { ok: false, gap: { kind: "unsupported_distance", distance: target.race_distance } };
  }
  if (!DAY.test(target.race_date)) {
    return { ok: false, gap: { kind: "invalid_goal", reason: `race_date "${target.race_date}" is not YYYY-MM-DD` } };
  }

  const targetTime = normalizeRaceTime(target.target_finish_time);
  if (targetTime === undefined) {
    return { ok: false, gap: { kind: "invalid_goal", reason: `target_finish_time "${target.target_finish_time}" is not H:MM[:SS]` } };
  }

  return {
    ok: true,
    request: {
      request_id: options.requestId,
      requested_mode: "new_season",
      requested_modifiers: [],
      goals: [
        {
          race_name: target.race_name || "目标赛事",
          location: null,
          distance: target.race_distance,
          race_date: target.race_date,
          target_time: targetTime,
          finish_only: targetTime === null,
          priority: "A",
        },
      ],
      availability: {
        // race_goal validates 3-6 training days at write time; clamp so a stale
        // row outside the kernel's 1-7 window degrades instead of throwing.
        weekly_run_days_max: Math.min(7, Math.max(1, Math.round(target.weekly_training_days) || 1)),
        available_training_windows: [],
        unavailable_days: [],
        max_session_duration_min: 180,
        allows_double_sessions: false,
        preferred_long_run_day: null,
        strength_sessions_per_week: 0,
        strength_available_days: [],
      },
      injury_declarations: [],
      environment_constraints: [],
      travel_constraints: [],
      preferences: [],
      prohibited_arrangements: [],
      active_plan_action: "none",
      user_confirmations: CONFIRMED_INTAKE,
      requested_as_of: options.now.toISOString(),
    },
  };
}

/** Accept `H:MM` and `H:MM:SS`; empty means finish-only (`null`). Anything else is invalid. */
function normalizeRaceTime(raw: string): string | null | undefined {
  const value = raw?.trim();
  if (!value) return null;
  const match = RACE_TIME.exec(value);
  if (match === null) return undefined;
  return `${match[1]}:${match[2]}:${match[3] ?? "00"}`;
}
