import assert from "node:assert/strict";
import test from "node:test";
import type { RaceCalendarContext, RaceTarget } from "../../data/dataProvider.js";
import { type MasterPlanGoalSnapshot, masterPlanGoalFromDocument, raceGoalQuestion } from "./goalQuestion.js";

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

/** active master plan content.goal 的常见形态：与 race_goal 同场同时可不同值（改目标未重生成计划）。 */
function planGoal(overrides: Partial<MasterPlanGoalSnapshot> = {}): MasterPlanGoalSnapshot {
  return {
    race_date: "2026-12-06",
    distance: "FM",
    target_time: "2:55:00",
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

test("a matching master-plan goal alone yields the confirm question", () => {
  // race_goal 缺失或指向别的比赛时，赛季计划的目标仍可作唯一候选。
  assert.equal(
    raceGoalQuestion({ goal: null, planGoal: planGoal(), race, itemType: "Marathon" }),
    "我查到你之前的比赛目标是 2:55:00，需要我按照这个目标帮你制定比赛策略吗？",
  );
  assert.equal(
    raceGoalQuestion({ goal: goal({ race_date: "2026-11-08" }), planGoal: planGoal(), race, itemType: "Marathon" }),
    "我查到你之前的比赛目标是 2:55:00，需要我按照这个目标帮你制定比赛策略吗？",
  );
});

test("two distinct matching candidates ask which one to use, race goal first", () => {
  assert.equal(
    raceGoalQuestion({ goal: goal(), planGoal: planGoal(), race, itemType: "Marathon" }),
    "我查到你的比赛目标是 2:50:00，赛季训练计划的目标是 2:55:00，要按哪个目标帮你制定这场比赛的策略？",
  );
});

test("identical candidates from both sources collapse into one confirm question", () => {
  // 计划由目标生成，两者一致是常态——不能问用户「选哪个」。
  assert.equal(
    raceGoalQuestion({ goal: goal(), planGoal: planGoal({ target_time: "2:50:00" }), race, itemType: "Marathon" }),
    "我查到你之前的比赛目标是 2:50:00，需要我按照这个目标帮你制定比赛策略吗？",
  );
});

test("a master-plan goal for another race day or distance never enters the candidates", () => {
  assert.equal(raceGoalQuestion({ goal: null, planGoal: planGoal({ race_date: "2026-11-08" }), race, itemType: "Marathon" }), DIRECT_QUESTION);
  assert.equal(raceGoalQuestion({ goal: null, planGoal: planGoal({ distance: "HM" }), race, itemType: "Marathon" }), DIRECT_QUESTION);
  assert.equal(raceGoalQuestion({ goal: null, planGoal: planGoal({ target_time: null }), race, itemType: "Marathon" }), DIRECT_QUESTION);
});

test("masterPlanGoalFromDocument extracts defensively and rejects malformed content", () => {
  assert.deepEqual(
    masterPlanGoalFromDocument({ goal: { race_date: "2026-12-06", distance: "FM", target_time: "2:55:00", race_name: "上海马拉松" } }),
    planGoal(),
  );
  // finish_only 计划（target_time=null）也是合法快照，只是进不了候选。
  assert.deepEqual(masterPlanGoalFromDocument({ goal: { race_date: "2026-12-06", distance: "FM", target_time: null } }), {
    race_date: "2026-12-06",
    distance: "FM",
    target_time: null,
  });
  assert.equal(masterPlanGoalFromDocument(null), null);
  assert.equal(masterPlanGoalFromDocument({}), null);
  assert.equal(masterPlanGoalFromDocument({ goal: null }), null);
  assert.equal(masterPlanGoalFromDocument({ goal: { race_date: 1206, distance: "FM" } }), null);
  assert.equal(masterPlanGoalFromDocument({ goal: { race_date: "2026-12-06", distance: "FM", target_time: 255 } }), null);
});
