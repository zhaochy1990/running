import assert from "node:assert/strict";
import test from "node:test";

import {
  GoalTransformError,
  isUuidGoalId,
  raceGoalRowFromCurrent,
  readCurrentGoal,
} from "../src/goal-transform.js";

const UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532";

// A slug-goal blob shaped like the real prod training_goal.json (gaohan).
const SLUG_BLOB = {
  current: {
    goal_id: "s1-2026-chengdu-fm",
    type: "race",
    race_date: "2026-10-18",
    race_distance: "FM",
    race_name: "成都马拉松",
    target_finish_time: "2:26:00",
    weekly_training_days: 6,
    available_time_slots: [],
    strength_willingness: null,
    created_at: "2026-07-09T12:40:22.873421+00:00",
    updated_at: "2026-07-09T12:40:22.873421+00:00",
  },
  history: [],
};

test("isUuidGoalId accepts a canonical uuid and rejects a legacy slug", () => {
  assert.equal(isUuidGoalId("f10bc353-01ab-4db1-af9f-d9305ea9a532"), true);
  assert.equal(isUuidGoalId("F10BC353-01AB-4DB1-AF9F-D9305EA9A532"), true);
  assert.equal(isUuidGoalId("s1-2026-chengdu-fm"), false);
  assert.equal(isUuidGoalId(""), false);
  assert.equal(isUuidGoalId(null), false);
});

test("readCurrentGoal returns the active goal_id + current, ignoring history", () => {
  const { goalId, current } = readCurrentGoal(SLUG_BLOB);
  assert.equal(goalId, "s1-2026-chengdu-fm");
  assert.equal(current.race_distance, "FM");
});

test("readCurrentGoal accepts a raw JSON string", () => {
  const { goalId } = readCurrentGoal(JSON.stringify(SLUG_BLOB));
  assert.equal(goalId, "s1-2026-chengdu-fm");
});

test("readCurrentGoal rejects missing current / goal_id / non-race type", () => {
  assert.throws(() => readCurrentGoal({ history: [] }), GoalTransformError);
  assert.throws(
    () => readCurrentGoal({ current: { race_distance: "FM" } }),
    GoalTransformError,
  );
  assert.throws(
    () =>
      readCurrentGoal({ current: { goal_id: "x", type: "time_trial" } }),
    GoalTransformError,
  );
  assert.throws(() => readCurrentGoal("not json"), GoalTransformError);
  assert.throws(() => readCurrentGoal([]), GoalTransformError);
});

test("raceGoalRowFromCurrent maps a slug blob to a re-minted active row", () => {
  const { current } = readCurrentGoal(SLUG_BLOB);
  const newId = "11111111-2222-4333-8444-555555555555";
  const row = raceGoalRowFromCurrent(UUID, current, newId);
  assert.deepEqual(row, {
    goal_id: newId,
    user_id: UUID,
    status: "active",
    active_flag: 1,
    race_date: "2026-10-18",
    race_distance: "FM",
    race_name: "成都马拉松",
    target_finish_time: "2:26:00",
    weekly_training_days: 6,
    available_time_slots: "[]",
    strength_willingness: null,
    race_location: null,
    race_timezone: null,
    // +00:00 → UTC, microseconds preserved (MySQL rounds to datetime(3) at rest).
    created_at: "2026-07-09 12:40:22.873421",
    updated_at: "2026-07-09 12:40:22.873421",
  });
});

test("raceGoalRowFromCurrent serialises a populated slot list and keeps a uuid id", () => {
  const current = {
    goal_id: UUID,
    race_date: "2026-05-01",
    race_distance: "HM",
    weekly_training_days: "4", // numeric string → int
    available_time_slots: ["morning", "evening"],
    strength_willingness: "high",
  };
  const row = raceGoalRowFromCurrent(UUID, current, UUID);
  assert.equal(row.goal_id, UUID);
  assert.equal(row.weekly_training_days, 4);
  assert.equal(row.available_time_slots, '["morning","evening"]');
  assert.equal(row.strength_willingness, "high");
  assert.equal(row.race_name, null);
  assert.equal(row.target_finish_time, null);
  // No created_at/updated_at in the source → null (caller stamps the run time).
  assert.equal(row.created_at, null);
  assert.equal(row.updated_at, null);
});

test("raceGoalRowFromCurrent requires race_date, race_distance and a goal_id", () => {
  const ok = { race_date: "2026-05-01", race_distance: "HM", weekly_training_days: 3 };
  assert.throws(
    () => raceGoalRowFromCurrent(UUID, { race_distance: "HM" }, UUID),
    GoalTransformError,
  );
  assert.throws(
    () => raceGoalRowFromCurrent(UUID, { race_date: "2026-05-01" }, UUID),
    GoalTransformError,
  );
  assert.throws(() => raceGoalRowFromCurrent(UUID, ok, ""), GoalTransformError);
});

test("raceGoalRowFromCurrent rejects a non-array available_time_slots", () => {
  const current = {
    race_date: "2026-05-01",
    race_distance: "HM",
    weekly_training_days: 3,
    available_time_slots: "morning",
  };
  assert.throws(
    () => raceGoalRowFromCurrent(UUID, current, UUID),
    GoalTransformError,
  );
});
