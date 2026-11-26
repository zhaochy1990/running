import { masterPlanToContent, type RunnerSnapshot, RunnerSnapshotSchema } from "@stride/coach-agent";
import { createTestCompletedOutcomeV3, createTestWeeklyPlanDoc } from "@stride/coach-agent/test-fixtures";
import { addDays, type WeeklyPlan, WeeklyPlanSchema, weekFolder } from "@stride/contract";
import { encodeExecutionMessage } from "../../src/eval/codec.js";
import type { ClaimResponse, ExecutionInput, GenerateReceipt } from "../../src/eval/protocol.js";

export const RUNNER_ID = "11111111-2222-4333-8333-333333333333";

const activity = (shanghaiDay: string, distanceM: number) => ({
  userId: RUNNER_ID,
  labelId: `label-${shanghaiDay}`,
  name: "Easy Run",
  sportName: "户外跑步",
  date: `${shanghaiDay}T07:00:00+08:00`,
  shanghaiDay,
  distanceM,
  durationS: distanceM / 3,
  avgPaceSKm: 300,
  bestKmPace: null,
  maxPace: null,
  avgHr: 150,
  maxHr: 170,
  avgCadence: null,
  maxCadence: null,
  avgPower: null,
  maxPower: null,
  avgStepLenCm: null,
  ascentM: null,
  descentM: null,
  strideDose: 50,
  strideSessionClass: "long_easy",
  temperature: null,
  humidity: null,
  feelsLike: null,
  windSpeed: null,
  sportNote: null,
  sport: "run_outdoor",
  feel: null,
  feelNote: null,
  verticalOscillationMm: null,
  groundContactTimeMs: null,
  verticalRatioPct: null,
  pauses: null,
  provider: "coros",
  laps: [],
});

/** 三周各两跑（周一/周六），截止日 2026-10-23（周五）。 */
export function createSnapshotRecords() {
  const days = ["2026-10-05", "2026-10-10", "2026-10-12", "2026-10-17", "2026-10-19", "2026-10-23"];
  return {
    profile: { userId: RUNNER_ID, displayName: "runner-a", dob: null, sex: "male", heightCm: 175, weightKg: 70, runningAgeRange: "3+" },
    injuries: [],
    race_target: {
      goal_id: "goal-1",
      user_id: RUNNER_ID,
      status: "active",
      race_date: "2027-03-21",
      race_distance: "FM",
      race_name: "全马目标赛",
      target_finish_time: "3:10:00",
      weekly_training_days: 5,
    },
    personal_bests: [
      { distance: "10K", timeSec: 2400, achievedAt: "2026-04-26", activityLabelId: "pb-10k" },
      { distance: "FM", timeSec: 11721, achievedAt: "2026-03-08", activityLabelId: "pb-fm" },
    ],
    running_calibration: null,
    race_history: [
      {
        date: "2026-03-08",
        labelId: "race-1",
        name: "马拉松",
        sport: "run_outdoor",
        distanceKm: 42.4,
        durationMin: 195.3,
        avgPaceSKm: 276,
        avgHr: 160,
        maxHr: 175,
        feel: 7,
        source: { races: true, sessionClass: true },
      },
      {
        date: "2026-04-12",
        labelId: "race-2",
        name: "半马",
        sport: "run_outdoor",
        distanceKm: 21.2,
        durationMin: 91.7,
        avgPaceSKm: 259,
        avgHr: 165,
        maxHr: 178,
        feel: 7,
        source: { races: true, sessionClass: false },
      },
    ],
    activities: days.map((day, index) => activity(day, index % 2 === 0 ? 8000 : 16000)),
    daily_training_load: days.map((day) => ({
      date: day,
      trainingDose: 50,
      acuteLoad: 20,
      chronicLoad: 40,
      form: -20,
      loadRatio: 0.5,
      coverageStatus: "complete",
    })),
    daily_recovery: days.map((day) => ({ date: day, rhr: 48, hrv: 55 })),
    active_master_plan: null,
    sync_coverage: null,
  };
}

export function createSnapshot(): RunnerSnapshot {
  return RunnerSnapshotSchema.parse({
    schema: "plan-eval-runner-snapshot/v1",
    snapshot_id: "snapshot-1",
    username: "runner-a",
    generation_kind: "new_season",
    event: "FM",
    target_time: "3:10:00",
    as_of_day: "2026-10-23",
    constraints: { max_run_days_per_week: 5, no_run_days: [] },
    records: createSnapshotRecords(),
    provenance: { source: "test", exported_at: "2026-11-24T00:00:00.000Z" },
  });
}

export const EXECUTION_ID = "exec-1";
export const executionMessage = () => encodeExecutionMessage(EXECUTION_ID);

export const input: ExecutionInput = { artifact_type: "master_plan", request: {}, snapshot: createSnapshot(), as_of: "2026-10-23T23:59:59+08:00" };
export const receipt: GenerateReceipt = {
  receipt_id: "receipt-1",
  snapshot_execution_id: EXECUTION_ID,
  generate_status: "done",
  artifact_id: "artifact-1",
  evaluate_status: "pending",
  received_at: "2026-11-24T00:00:00.000Z",
};
export const leased = (epoch = 1): ClaimResponse => ({ status: "leased", lease_epoch: epoch, lease_expires_at: "2026-11-24T00:01:00.000Z", input });

export function weekDoc(week: number): WeeklyPlan {
  const old = createTestWeeklyPlanDoc(week);
  const dateFrom = addDays("2026-10-05", (week - 1) * 7);
  const shifted = JSON.stringify(old).replace(/2026-\d{2}-\d{2}/g, (day) => addDays(day, 56));
  return WeeklyPlanSchema.parse({ ...JSON.parse(shifted), week_name: weekFolder(dateFrom) });
}

export function rollingSnapshot(lastWeek: number, event: "FM" | "HM" = "FM") {
  const { artifact } = createTestCompletedOutcomeV3({ totalWeeks: 10 });
  const content = masterPlanToContent(
    {
      ...artifact.plan,
      start_date: "2026-10-05",
      end_date: "2026-12-13",
      goal: { ...artifact.plan.goal, distance: event, target_time: event === "HM" ? "1:20:00" : "2:55:00", race_date: "2026-12-13" },
    },
    "plan-eval-season",
    { weekly_run_days_max: 6 },
  );
  Object.assign(content, {
    master_plan_id: "plan-eval-season",
    policy: artifact.policy,
    skeleton: artifact.skeleton,
    anchor: artifact.anchor,
    weekly_docs: [],
  });
  const snapshot = createSnapshot();
  return RunnerSnapshotSchema.parse({
    ...snapshot,
    generation_kind: lastWeek === 2 ? "rolling_catch_up" : "rolling_continue",
    event,
    as_of_day: "2026-10-26",
    as_of: "2026-10-26T08:00:00+08:00",
    expected_start_week: 99,
    records: {
      ...snapshot.records,
      active_master_plan: { planId: "plan-eval-season", revision: 1, status: "active", content },
      weekly_plan_weeks: Array.from({ length: lastWeek }, (_, i) => ({
        week_start: addDays("2026-10-05", i * 7),
        master_plan_id: "plan-eval-season",
        revision: 1,
      })),
      weekly_plans: Array.from({ length: lastWeek }, (_, i) => ({ week_start: addDays("2026-10-05", i * 7), content: weekDoc(i + 1) })),
    },
  });
}
