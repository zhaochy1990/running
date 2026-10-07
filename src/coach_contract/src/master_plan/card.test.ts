import assert from "node:assert/strict";
import test from "node:test";
import { MasterPlanCardSchema } from "./card.js";

function validCard(): Record<string, unknown> {
  return {
    goal: { race_name: "无锡马拉松", distance: "FM", race_date: "2027-03-21", target_time: "3:30:00" },
    start_date: "2026-10-05",
    end_date: "2027-03-21",
    total_weeks: 24,
  };
}

test("MasterPlanCardSchema accepts a well-formed card", () => {
  const parsed = MasterPlanCardSchema.safeParse(validCard());
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
});

test("MasterPlanCardSchema accepts an empty target_time (finish-only goal)", () => {
  const card = validCard() as { goal: { target_time: string } };
  card.goal.target_time = "";
  assert.equal(MasterPlanCardSchema.safeParse(card).success, true);
});

test("MasterPlanCardSchema carries an optional plan_id for the activate CTA (#429)", () => {
  const withId = { ...validCard(), plan_id: "b34c6d7e-1111-4222-8333-444455556666" };
  assert.equal(MasterPlanCardSchema.safeParse(withId).success, true);
  const parsed = MasterPlanCardSchema.safeParse(withId);
  assert.equal(parsed.success && parsed.data.plan_id, withId.plan_id);
  // 空串拒绝：落库失败/降级卡片必须整个省略字段，而不是传空值
  const emptyId = { ...validCard(), plan_id: "" };
  assert.equal(MasterPlanCardSchema.safeParse(emptyId).success, false);
});

test("MasterPlanCardSchema rejects an unsupported distance and a malformed date", () => {
  const badDistance = validCard() as { goal: { distance: string } };
  badDistance.goal.distance = "10K";
  assert.equal(MasterPlanCardSchema.safeParse(badDistance).success, false);
  const badDate = validCard() as { goal: { race_date: string } };
  badDate.goal.race_date = "21/03/2027";
  assert.equal(MasterPlanCardSchema.safeParse(badDate).success, false);
});

test("MasterPlanCardSchema rejects an empty race_name and a non-positive total_weeks", () => {
  const badName = validCard() as { goal: { race_name: string } };
  badName.goal.race_name = "";
  assert.equal(MasterPlanCardSchema.safeParse(badName).success, false);
  const badWeeks = validCard() as { total_weeks: number };
  badWeeks.total_weeks = 0;
  assert.equal(MasterPlanCardSchema.safeParse(badWeeks).success, false);
});
