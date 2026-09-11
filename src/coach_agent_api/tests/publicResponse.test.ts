import assert from "node:assert/strict";
import test from "node:test";
import { toPublicHistory, tryToPublicResponse } from "../src/publicResponse.js";

const REQUEST = {
  request_id: "req-1",
  requested_mode: "new_season",
  requested_modifiers: [],
  goals: [{ race_name: "西安马拉松", distance: "FM", race_date: "2026-10-18", target_time: "2:50:00", finish_only: false, priority: "A" }],
  availability: {
    weekly_run_days_max: 6,
    available_training_windows: [],
    unavailable_days: [],
    max_session_duration_min: 180,
    allows_double_sessions: true,
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
};

const PROPOSAL_TEXT = JSON.stringify({
  kind: "generate_master_plan",
  summary: "为你生成一份 16 周全马训练计划",
  request: REQUEST,
});

test("tryToPublicResponse surfaces a drafted proposal as generation_proposed", () => {
  const result = tryToPublicResponse({
    messages: [{ type: "ai", content: PROPOSAL_TEXT }],
  });
  assert.deepEqual(result, {
    status: "generation_proposed",
    summary: "为你生成一份 16 周全马训练计划",
    job_type: "generate_master_plan",
    proposal: REQUEST,
  });
});

test("tryToPublicResponse keeps plain assistant text as completed", () => {
  assert.deepEqual(tryToPublicResponse({ messages: [{ type: "ai", content: "训练状态稳定。" }] }), {
    status: "completed",
    message: "训练状态稳定。",
  });
});

test("toPublicHistory renders a proposal as a generation_proposed card", () => {
  assert.deepEqual(
    toPublicHistory([
      { type: "human", content: '{"message":"帮我生成一份全马计划"}' },
      { type: "ai", content: PROPOSAL_TEXT },
    ]),
    [
      { role: "user", content: "帮我生成一份全马计划" },
      { role: "assistant", kind: "generation_proposed", summary: "为你生成一份 16 周全马训练计划", job_type: "generate_master_plan", proposal: REQUEST },
    ],
  );
});

test("toPublicHistory renders a confirmation message as a plan_job card", () => {
  assert.deepEqual(
    toPublicHistory([
      { type: "ai", content: PROPOSAL_TEXT },
      { type: "ai", content: JSON.stringify({ kind: "plan_job_confirmed", job_id: "job-1", job_type: "generate_master_plan" }) },
    ]),
    [
      { role: "assistant", kind: "generation_proposed", summary: "为你生成一份 16 周全马训练计划", job_type: "generate_master_plan", proposal: REQUEST },
      { role: "assistant", kind: "plan_job", job_id: "job-1", job_type: "generate_master_plan" },
    ],
  );
});

test("toPublicHistory leaves malformed proposal-looking text as plain content", () => {
  assert.deepEqual(toPublicHistory([{ type: "ai", content: '{"kind":"generate_master_plan"}' }]), [
    { role: "assistant", content: '{"kind":"generate_master_plan"}' },
  ]);
});
