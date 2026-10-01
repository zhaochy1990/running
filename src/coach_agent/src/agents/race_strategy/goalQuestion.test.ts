import assert from "node:assert/strict";
import test from "node:test";
import type { RaceCalendarContext, RaceTarget } from "../../data/dataProvider.js";
import { raceGoalQuestion } from "./goalQuestion.js";

const DIRECT_QUESTION = "你这场比赛的目标成绩是多少？";

const race: Pick<RaceCalendarContext, "name" | "name_cn" | "race_date"> = {
  name: "Shanghai Marathon",
  name_cn: "上海马拉松",
  race_date: "2026-12-06",
};

function goal(overrides: Partial<RaceTarget> = {}): RaceTarget {
  return {
    goal_id: "g1",
    user_id: "u1",
    status: "active",
    race_date: "2026-12-06",
    race_distance: "FM",
    race_name: "上海马拉松",
    target_finish_time: "2:50:00",
    weekly_training_days: 5,
    ...overrides,
  };
}

test("a stored goal matching this race yields the one-sentence confirm question", () => {
  const question = raceGoalQuestion({ goal: goal(), race, itemType: "Marathon" });
  assert.equal(question, "我查到你之前的比赛目标是 2:50:00，需要我按照这个目标帮你制定比赛策略吗？");
});

test("no goal, no race context or lookup failure yields the direct question", () => {
  assert.equal(raceGoalQuestion({ goal: null, race, itemType: "Marathon" }), DIRECT_QUESTION);
  assert.equal(raceGoalQuestion({ goal: goal(), race: null, itemType: "Marathon" }), DIRECT_QUESTION);
  assert.equal(raceGoalQuestion({ goal: null, race: null, itemType: "" }), DIRECT_QUESTION);
});

test("a goal for a different race day or event never gets proposed", () => {
  assert.equal(raceGoalQuestion({ goal: goal({ race_date: "2026-11-08" }), race, itemType: "Marathon" }), DIRECT_QUESTION);
  assert.equal(raceGoalQuestion({ goal: goal({ race_distance: "HM" }), race, itemType: "Marathon" }), DIRECT_QUESTION);
  assert.equal(raceGoalQuestion({ goal: goal({ race_distance: "FM" }), race, itemType: "HalfMarathon" }), DIRECT_QUESTION);
});

test("an unclear stored target time is not proposed", () => {
  assert.equal(raceGoalQuestion({ goal: goal({ target_finish_time: "" }), race, itemType: "Marathon" }), DIRECT_QUESTION);
  assert.equal(raceGoalQuestion({ goal: goal({ target_finish_time: "sub3" }), race, itemType: "Marathon" }), DIRECT_QUESTION);
  // 列可空：运行时可能拿到 null，不得抛错。
  assert.equal(raceGoalQuestion({ goal: goal({ target_finish_time: null as unknown as string }), race, itemType: "Marathon" }), DIRECT_QUESTION);
});

test("an unmapped item type cannot be verified against the goal distance", () => {
  assert.equal(raceGoalQuestion({ goal: goal(), race, itemType: "Relay" }), DIRECT_QUESTION);
});

test("race dates carrying a time component still match by day", () => {
  const question = raceGoalQuestion({ goal: goal(), race: { ...race, race_date: "2026-12-06T09:30:00Z" }, itemType: "Marathon" });
  assert.match(question, /2:50:00/);
});
