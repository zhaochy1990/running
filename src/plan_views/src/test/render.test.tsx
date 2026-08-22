import { render } from "@testing-library/react";
import { MasterPlanView } from "../master-plan/MasterPlanView";
import type { WeekDetail, WeeklyPlanEnvelope } from "../types";
import { WeeklyPlanView } from "../weekly-plan/WeeklyPlanView";

const plan: WeeklyPlanEnvelope = {
  plan_id: "p1",
  week_name: "2026-08-03",
  date_from: "2026-08-03",
  date_to: "2026-08-09",
  master_plan_id: null,
  status: "active",
  revision: 1,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  content_version: 2,
  content: {
    schema: "weekly-plan/v1",
    week_name: "2026-08-03",
    sessions: [
      {
        schema: "plan-session/v1",
        date: "2026-08-03",
        session_index: 0,
        kind: "run",
        summary: "Easy 10k",
        spec: null,
        notes_md: null,
        total_distance_m: 10000,
        total_duration_s: null,
        estimated_dose: 80,
        scheduled_workout_id: null,
      },
    ],
    nutrition: [],
    notes_md: null,
    coach_notes: null,
  },
};

const week: WeekDetail = {
  week_name: "2026-08-03",
  date_from: "2026-08-03",
  date_to: "2026-08-09",
  plan: null,
  feedback: "感觉不错",
  feedback_created_at: null,
  feedback_updated_at: null,
  activities: [],
  total_km: 0,
  total_duration_s: 0,
  total_duration_fmt: "00:00:00",
  activity_count: 0,
  structured: null,
};

test("WeeklyPlanView renders schedule and feedback", () => {
  const { container, getByText } = render(<WeeklyPlanView plan={plan} week={week} />);
  expect(getByText("本周课表")).toBeTruthy();
  expect(getByText("Easy 10k")).toBeTruthy();
  expect(container.querySelector(".master-plan-surface")).toBeTruthy();
});

test("WeeklyPlanView shows adjust button when actions provided", () => {
  const { getByText } = render(<WeeklyPlanView plan={plan} week={week} actions={{ onAdjust: () => {} }} />);
  expect(getByText("调整")).toBeTruthy();
});

test("MasterPlanView renders season overview", () => {
  const { container } = render(
    <MasterPlanView
      plan={{
        goal: { goal_id: "g", race_name: "测试赛" },
        start_date: "2026-01-01",
        end_date: "2026-03-01",
        total_weeks: 8,
        phases: [
          {
            id: "p1",
            name: "基础期",
            start_date: "2026-01-01",
            end_date: "2026-02-01",
            focus: "有氧基础",
            weekly_distance_km_low: 30,
            weekly_distance_km_high: 40,
            key_session_types: [],
            milestone_ids: [],
            phase_type: "base",
          },
        ],
        milestones: [],
        weeks: [],
        training_principles: ["循序渐进"],
        generated_by: "test",
        current_phase_id: null,
        current_week_number: null,
        next_milestone: null,
      }}
    />,
  );
  expect(container.textContent).toContain("测试赛");
  expect(container.querySelector(".master-plan-surface")).toBeTruthy();
});
