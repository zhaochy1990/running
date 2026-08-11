import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createMasterPlanGraph,
  FrozenMasterPlanContextProvider,
  MasterPlanGraphOutcome,
  MasterPlanGraphRequest,
} from "../graph/master_plan/index.js";
import { createAssessmentSnapshot, createTestAthleteAssessment, createTestGoalAssessment } from "../graph/master_plan/testFixtures.js";

const request = MasterPlanGraphRequest.parse({
  request_id: "local-new-season",
  requested_mode: "new_season",
  requested_modifiers: [],
  goals: [{
    race_name: "西安马拉松",
    location: "西安",
    distance: "FM",
    race_date: "2026-10-18",
    target_time: "2:50:00",
    finish_only: false,
    priority: "A",
  }],
  availability: {
    weekly_run_days_max: 6,
    available_training_windows: [
      { day: "monday", start_time: "06:00", end_time: "08:00" },
      { day: "tuesday", start_time: "06:00", end_time: "08:00" },
      { day: "wednesday", start_time: "06:00", end_time: "08:00" },
      { day: "thursday", start_time: "06:00", end_time: "08:00" },
      { day: "friday", start_time: "06:00", end_time: "08:00" },
      { day: "saturday", start_time: "06:00", end_time: "09:00" },
    ],
    unavailable_days: ["sunday"],
    max_session_duration_min: 180,
    allows_double_sessions: false,
    preferred_long_run_day: "saturday",
    strength_sessions_per_week: 2,
    strength_available_days: ["monday", "thursday"],
  },
  injury_declarations: [],
  environment_constraints: [],
  travel_constraints: [],
  preferences: [],
  prohibited_arrangements: [],
  active_plan_action: "none",
  user_confirmations: {
    intake_complete: true,
    goals_confirmed: true,
    availability_confirmed: true,
    injury_history_confirmed: true,
    constraints_confirmed: true,
  },
});

const stubPlan = {
  status: "draft",
  goal: {
    race_name: "西安马拉松",
    distance: "FM",
    race_date: "2026-10-18",
    target_time: "2:50:00",
    timezone: "Asia/Shanghai",
    location: "西安",
  },
  start_date: "2026-10-12",
  end_date: "2026-10-18",
  total_weeks: 1,
  phases: [{
    name: "赛前减量期",
    start_date: "2026-10-12",
    end_date: "2026-10-18",
    focus: "Demonstrate the Kernel seam; planning quality arrives in follow-up slices.",
    weekly_distance_km_low: 42.195,
    weekly_distance_km_high: 42.195,
    key_session_types: ["race"],
    milestones: [{
      type: "race",
      date: "2026-10-18",
      target: "西安马拉松 2:50:00",
      completed_actual: null,
    }],
    key_workouts: "Goal race",
    monitoring_triggers: ["Do not activate this stub plan"],
    coach_note: "Issue #342 validates the interface only.",
    strength: { sessions_per_week: 0, focus: "none", timing: "none" },
    recovery: {
      focus: "pre-race recovery",
      sleep_target_hours: "7-9",
      adjustment_trigger: "illness or pain",
    },
    is_completed: false,
    summary: null,
  }],
  weeks: [{
    week_index: 1,
    week_start: "2026-10-12",
    phase_name: "赛前减量期",
    target_weekly_km_low: 42.195,
    target_weekly_km_high: 42.195,
    key_sessions: [{
      type: "race",
      distance_km: 42.195,
      duration_min: 170,
      intensity: "goal race",
      purpose: "Demonstrate a strategic key session through the Kernel seam",
    }],
    is_recovery_week: false,
  }],
  training_principles: ["This inactive stub is not a training prescription."],
  generated_by: "coach_agent",
  version: 1,
  created_at: "2026-08-10T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
};

const generationId = "local-kernel-seam";
const graph = createMasterPlanGraph({
  assessmentModel: { async invoke() { return createTestAthleteAssessment(); } },
  goalAssessmentModel: { async invoke() { return createTestGoalAssessment(); } },
  contextProvider: new FrozenMasterPlanContextProvider(createAssessmentSnapshot()),
  skeletonModel: { async invoke() { return stubPlan; } },
});
const result = await graph.invoke(
  { request },
  { context: { userId: "local-testing-athlete", generationId } },
);
const outcome = MasterPlanGraphOutcome.parse(result.outcome);
if (outcome.decision !== "completed") {
  throw new Error(`local Kernel runner returned ${outcome.decision}`);
}

const outputDir = resolve(process.cwd(), "../../.omc/eval/master-plan", generationId);
await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeJson("request.json", request),
  writeJson("outcome.json", outcome),
  writeJson("final-draft.json", outcome.artifact),
]);
console.log(outputDir);

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
