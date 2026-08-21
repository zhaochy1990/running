import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getWeeks: vi.fn(),
  getMyProfile: vi.fn(),
  getWeek: vi.fn(),
  getWeekStrength: vi.fn(),
}));
const routerMocks = vi.hoisted(() => ({ navigate: vi.fn(), useParams: vi.fn(() => ({})) }));

vi.mock("../../api", () => ({
  getWeeks: apiMocks.getWeeks,
  getMyProfile: apiMocks.getMyProfile,
  getWeek: apiMocks.getWeek,
  getWeekStrength: apiMocks.getWeekStrength,
  getPlanDays: vi.fn(),
  updateWeeklyFeedback: vi.fn(),
  pushPlannedSession: vi.fn(),
}));
vi.mock("../../UserContextValue", () => ({ useUser: () => ({ user: "user-id" }) }));
vi.mock("../../lib/shanghai", () => ({ shanghaiToday: () => "2026-07-16" }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => routerMocks.navigate,
  useParams: () => routerMocks.useParams(),
}));

import { useCoachWeeklyPlan } from "../useCoachWeeklyPlan";
import type { WeekDetail } from "../../api";

function weekDetailWithSessions(): WeekDetail {
  return {
    week_name: "2026-07-13_07-19",
    date_from: "2026-07-13",
    date_to: "2026-07-19",
    plan: null,
    feedback: "",
    feedback_created_at: null,
    feedback_updated_at: null,
    activities: [],
    total_km: 0,
    total_duration_s: 0,
    total_duration_fmt: "",
    activity_count: 0,
    structured: {
      structured_status: "canonical",
      sessions: [
        {
          schema: "plan-session/v1",
          id: 0,
          date: "2026-07-13",
          session_index: 0,
          kind: "run",
          summary: "Easy 10km",
          spec: null,
          notes_md: null,
          total_distance_m: 10000,
          total_duration_s: 3600,
          pushable: false,
          scheduled_workout_id: null,
        },
      ],
      nutrition: [],
    },
  };
}

describe("useCoachWeeklyPlan", () => {
  beforeEach(() => {
    apiMocks.getWeeks.mockReset();
    apiMocks.getMyProfile.mockReset();
    apiMocks.getWeek.mockReset();
    routerMocks.navigate.mockReset();
    routerMocks.useParams.mockReturnValue({});
    apiMocks.getMyProfile.mockResolvedValue({ provider: "coros" });
  });

  it("finishes loading when the user has no training weeks", async () => {
    apiMocks.getWeeks.mockResolvedValue({ weeks: [] });

    const { result } = renderHook(() => useCoachWeeklyPlan());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.week).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("opens the current week when the API lists a future week first", async () => {
    apiMocks.getWeeks.mockResolvedValue({
      weeks: [
        { folder: "2026-07-20_07-26", date_from: "2026-07-20", date_to: "2026-07-26" },
        { folder: "2026-07-13_07-19", date_from: "2026-07-13", date_to: "2026-07-19" },
      ],
    });

    renderHook(() => useCoachWeeklyPlan());

    await waitFor(() => {
      expect(routerMocks.navigate).toHaveBeenCalledWith("/week/2026-07-13_07-19", { replace: true });
    });
  });

  it("builds planDays from the Go week detail structured payload (not Python /plan/days)", async () => {
    routerMocks.useParams.mockReturnValue({ folder: "2026-07-13_07-19" });
    apiMocks.getWeeks.mockResolvedValue({
      weeks: [{ folder: "2026-07-13_07-19", date_from: "2026-07-13", date_to: "2026-07-19" }],
    });
    apiMocks.getWeek.mockResolvedValue(weekDetailWithSessions());
    apiMocks.getWeekStrength.mockResolvedValue(null);

    const { result } = renderHook(() => useCoachWeeklyPlan());

    await waitFor(() => expect(result.current.loading).toBe(false));
    // 7 contiguous days, with the structured session surfaced on its date.
    expect(result.current.planDays).toHaveLength(7);
    expect(result.current.planDays[0].date).toBe("2026-07-13");
    expect(result.current.planDays[0].sessions).toHaveLength(1);
    expect(result.current.planDays[0].sessions[0].summary).toBe("Easy 10km");
  });
});
