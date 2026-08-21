import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import WeekLayout from "../WeekLayout";
import { buildPlanDaysFromWeekDetail, mergeStructuredIntoPlanDays } from "../../types/plan";
import type { WeekDetail, WeekSummary, PlannedSessionRow } from "../../api";
import type { StructuredStatus } from "../../types/plan";

// Hoisted mocks for the api module. The calendar tab now reads entirely from
// the Go `/weeks` detail response (weekDetail.structured) — there is no
// `/plan/days` (Python/Azure) dependency in the calendar path.
const mocks = vi.hoisted(() => ({
  getWeeks: vi.fn(),
  getWeek: vi.fn(),
  reparsePlan: vi.fn(),
  pushPlannedSession: vi.fn(),
  updateWeeklyFeedback: vi.fn(),
}));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    getWeeks: mocks.getWeeks,
    getWeek: mocks.getWeek,
    reparsePlan: mocks.reparsePlan,
    pushPlannedSession: mocks.pushPlannedSession,
    updateWeeklyFeedback: mocks.updateWeeklyFeedback,
  };
});

vi.mock("../../UserContextValue", () => ({
  useUser: () => ({ user: "zhaochaoyi" }),
}));

const FOLDER = "2026-04-20_04-26(W0)";

const weeks: WeekSummary[] = [
  {
    folder: FOLDER,
    date_from: "2026-04-20",
    date_to: "2026-04-26",
    has_plan: true,
    has_feedback: false,
    has_body_composition: false,
    plan_title: "Week 0",
    activity_count: 3,
    total_km: 35,
    total_duration_s: 12600,
    total_duration_fmt: "3:30:00",
  },
];

function buildWeekDetail(structuredStatus: StructuredStatus | null): WeekDetail {
  return {
    week_name: FOLDER,
    date_from: "2026-04-20",
    date_to: "2026-04-26",
    plan: "# Week 0\n\nEasy week.",
    feedback: "",
    feedback_created_at: null,
    feedback_updated_at: null,
    activities: [],
    total_km: 35,
    total_duration_s: 12600,
    total_duration_fmt: "3:30:00",
    activity_count: 3,
    structured: structuredStatus !== null ? { structured_status: structuredStatus } : null,
  };
}

// A structured session shaped like the Go `/weeks` detail response (no
// `id`/`pushable`/`scheduled_workout_id` — those are synthesized at render).
const SAMPLE_STEP = {
  step_kind: "work",
  duration: { kind: "distance_m", value: 10000 },
  target: { kind: "pace_s_km", low: 360, high: 330 },
  note: null,
};

const SAMPLE_BLOCK = {
  repeat: 1,
  steps: [SAMPLE_STEP],
};

const SAMPLE_SPEC = {
  schema: "run-workout/v1",
  name: "easy",
  date: "2026-04-20",
  note: null,
  blocks: [SAMPLE_BLOCK],
};

function buildStructuredSession(summary: string): PlannedSessionRow {
  return {
    schema: "plan-session/v1",
    id: 0,
    date: "2026-04-20",
    session_index: 0,
    kind: "run",
    summary,
    spec: SAMPLE_SPEC,
    notes_md: null,
    total_distance_m: 10000,
    total_duration_s: 3600,
    pushable: true,
  } as unknown as PlannedSessionRow;
}

beforeEach(() => {
  mocks.getWeeks.mockResolvedValue({ weeks });
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderAt(path = `/week/${FOLDER}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/week/:folder" element={<WeekLayout />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WeekLayout — calendar tab", () => {
  it("renders 7 day-cards when status=fresh", async () => {
    mocks.getWeek.mockResolvedValue(buildWeekDetail("fresh"));

    renderAt();
    await waitFor(() => expect(screen.getByText("训练计划")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "日历" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("day-card")).toHaveLength(7);
    });
    expect(screen.queryByTestId("reparse-banner")).not.toBeInTheDocument();
  });

  it("opens a canonical calendar when legacy markdown is absent", async () => {
    mocks.getWeek.mockResolvedValue({
      ...buildWeekDetail("canonical"),
      plan: undefined,
    });

    renderAt();

    await waitFor(() => {
      expect(screen.getAllByTestId("day-card")).toHaveLength(7);
    });
    expect(screen.getByRole("button", { name: "日历" })).toHaveClass("text-accent-green");
  });

  it("opens training records when no plan is available", async () => {
    mocks.getWeek.mockResolvedValue({
      ...buildWeekDetail(null),
      plan: undefined,
    });

    renderAt();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "训练记录 (3)" })).toHaveClass("text-accent-green");
    });
  });

  it("shows reparse banner when status=parse_failed and triggers reparsePlan", async () => {
    mocks.getWeek.mockResolvedValue(buildWeekDetail("parse_failed"));
    mocks.reparsePlan.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true, folder: FOLDER, structured_status: "fresh", parse_error: null },
    });

    renderAt();
    await waitFor(() => expect(screen.getByText("训练计划")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "日历" }));

    await waitFor(() => expect(screen.getByTestId("reparse-banner")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "重新解析" }));

    await waitFor(() => {
      expect(mocks.reparsePlan).toHaveBeenCalledWith("zhaochaoyi", FOLDER);
    });
  });

  it("shows backfill banner when status=backfilled", async () => {
    mocks.getWeek.mockResolvedValue(buildWeekDetail("backfilled"));

    renderAt();
    await waitFor(() => expect(screen.getByText("训练计划")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "日历" }));

    await waitFor(() => expect(screen.getByTestId("reparse-banner")).toBeInTheDocument());
    expect(screen.getByTestId("backfill-banner")).toBeInTheDocument();
  });

  it("renders structured sessions from the Go /weeks response (no Python /plan/days)", async () => {
    // The calendar is built entirely from weekDetail.structured, so a MySQL-only
    // week with no Azure plan-days rows still renders its sessions.
    const structuredWeek = buildWeekDetail("canonical");
    structuredWeek.plan = undefined;
    structuredWeek.structured = {
      structured_status: "canonical",
      sessions: [buildStructuredSession("Structured Easy 10km")],
      nutrition: [],
    };

    mocks.getWeek.mockResolvedValue(structuredWeek);

    renderAt();

    // Calendar is the default tab for a canonical structured week.
    await waitFor(() => expect(screen.getByRole("button", { name: "日历" })).toHaveClass("text-accent-green"));
    // The session from the structured payload must be visible.
    await waitFor(() => expect(screen.getByText("Structured Easy 10km")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByTestId("day-card")).toHaveLength(7));
  });
});

describe("buildPlanDaysFromWeekDetail", () => {
  it("builds 7 contiguous days and synthesizes id/pushable for structured sessions", () => {
    const wd = {
      week_name: FOLDER,
      date_from: "2026-04-20",
      date_to: "2026-04-26",
      structured: {
        structured_status: "canonical" as StructuredStatus,
        sessions: [buildStructuredSession("Easy 10km")],
        nutrition: [],
      },
    } as unknown as WeekDetail;

    const days = buildPlanDaysFromWeekDetail(wd);

    expect(days).toHaveLength(7);
    expect(days[0].date).toBe("2026-04-20");
    expect(days[0].sessions).toHaveLength(1);
    expect(days[0].sessions[0].summary).toBe("Easy 10km");
    expect(days[0].sessions[0].id).toBe(0);
    expect(days[0].sessions[0].pushable).toBe(true);
    // Remaining days are empty placeholders.
    expect(days[1].sessions).toHaveLength(0);
  });

  it("returns empty days when structured is null", () => {
    const days = buildPlanDaysFromWeekDetail(buildWeekDetail(null));
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.sessions.length === 0)).toBe(true);
  });
});

describe("mergeStructuredIntoPlanDays", () => {
  it("keeps existing (Azure/Python) rows and fills gaps from structured", () => {
    const existing = [
      { date: "2026-04-20", sessions: [{ schema: "plan-session/v1", id: 1, date: "2026-04-20", session_index: 0, kind: "run", summary: "Azure Easy", spec: null, notes_md: null, total_distance_m: 10000, total_duration_s: 3600, pushable: true }], nutrition: null },
      { date: "2026-04-21", sessions: [], nutrition: null },
    ];
    const structured = {
      structured_status: "canonical" as StructuredStatus,
      sessions: [buildStructuredSession("Structured Easy 10km")],
      nutrition: [],
    };
    const out = mergeStructuredIntoPlanDays(existing, structured);
    // Existing row wins on the same date/session_index key.
    expect(out[0].sessions[0].summary).toBe("Azure Easy");
    expect(out[0].sessions[0].id).toBe(1);
  });
});
