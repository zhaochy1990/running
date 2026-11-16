import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOnboardingSyncSession: vi.fn(),
  postOnboardingSyncSession: vi.fn(),
}));

vi.mock("../../api", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number) {
      super(`API error: ${status}`);
      this.status = status;
    }
  },
  getOnboardingSyncSession: mocks.getOnboardingSyncSession,
  postOnboardingSyncSession: mocks.postOnboardingSyncSession,
}));

import OnboardingSyncBanner from "../OnboardingSyncBanner";
import { OnboardingSyncStatusProvider } from "../../onboardingSync/OnboardingSyncStatusProvider";

function view(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess-1",
    state: "running",
    shell_ready: true,
    provider: "coros",
    binding_revision: 1,
    anchor_day: "2026-11-17",
    retry_count: 0,
    stages: [
      {
        stage: "recent_raw",
        status: "completed",
        readiness: "ready",
        target_from: "2026-08-19",
        target_to: "2026-11-17",
        observed_from: "2026-08-19",
        observed_to: "2026-11-17",
      },
      {
        stage: "historical_raw",
        status: "running",
        readiness: "running",
        target_from: "2019-01-01",
        target_to: "2026-08-18",
        observed_from: "2026-05-01",
        observed_to: "2026-08-18",
        gaps: [{ from: "2026-06-01", to: "2026-06-02", reason: "provider_5xx" }],
      },
    ],
    readiness: {
      shell_ready: true,
      recent_data: "ready",
      recent_analysis: "partial",
      extended_data: "not_started",
      historical_data: "running",
      historical_analysis: "not_started",
      auxiliary: "not_started",
    },
    created_at: "2026-11-17T00:00:00Z",
    updated_at: "2026-11-17T00:00:00Z",
    ...overrides,
  };
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <OnboardingSyncStatusProvider>
        <OnboardingSyncBanner />
      </OnboardingSyncStatusProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("OnboardingSyncBanner", () => {
  it("shows the global collapsible progress with readiness, coverage and gaps", async () => {
    mocks.getOnboardingSyncSession.mockResolvedValue(view());

    renderBanner();

    expect(await screen.findByLabelText("首次数据同步状态")).toBeInTheDocument();
    expect(screen.getByText("部分可用")).toBeInTheDocument(); // 近期分析 chip
    expect(screen.getByText("近期数据（活动 / 健康）")).toBeInTheDocument();
    expect(screen.getByText(/目标范围 2019-01-01 ~ 2026-08-18/)).toBeInTheDocument();
    expect(screen.getByText(/缺项：2026-06-01 ~ 2026-06-02（provider_5xx）/)).toBeInTheDocument();
    // Recent details are reachable as soon as recent data is ready — even
    // while the historical stage is still running.
    expect(screen.getByRole("link", { name: "查看近期活动" })).toHaveAttribute("href", "/activities");
  });

  it("renders nothing when no session exists (legacy users, switches off)", async () => {
    const { ApiError } = await import("../../api");
    mocks.getOnboardingSyncSession.mockRejectedValueOnce(new ApiError(404)).mockRejectedValue(new ApiError(403));

    const { container } = renderBanner();

    await waitFor(() => expect(mocks.getOnboardingSyncSession).toHaveBeenCalledTimes(1));
    // A 404/403 stops the poller — no further ticks, no banner.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.getOnboardingSyncSession).toHaveBeenCalledTimes(1);
    expect(container.querySelector("section")).toBeNull();
  });

  it("offers a retry that re-dispatches only the session's unfinished work", async () => {
    mocks.getOnboardingSyncSession.mockResolvedValue(
      view({
        state: "failed",
        error: "recent fetch failed",
        readiness: { ...view().readiness, recent_data: "failed" },
      }),
    );
    mocks.postOnboardingSyncSession.mockResolvedValue({ ok: true, status: 200, data: view({ state: "running" }) });

    renderBanner();

    fireEvent.click(await screen.findByRole("button", { name: "重试失败项" }));

    await waitFor(() => expect(mocks.postOnboardingSyncSession).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/同步进行中/)).toBeInTheDocument();
  });

  it("hides for completed sessions and keeps gaps visible for completed_with_gaps", async () => {
    mocks.getOnboardingSyncSession.mockResolvedValue(view({ state: "completed" }));
    const first = renderBanner();

    await waitFor(() => expect(mocks.getOnboardingSyncSession).toHaveBeenCalledTimes(1));
    expect(first.container.querySelector("section")).toBeNull();
    first.unmount();

    // A fresh mount (next visit / reload) with a terminal-with-gaps session
    // still surfaces the gaps honestly instead of hiding them.
    mocks.getOnboardingSyncSession.mockClear();
    mocks.getOnboardingSyncSession.mockResolvedValue(view({ state: "completed_with_gaps" }));
    renderBanner();

    expect(await screen.findByLabelText("首次数据同步状态")).toBeInTheDocument();
    expect(screen.getByText(/同步完成（部分缺项）/)).toBeInTheDocument();
  });

  it("collapses and expands, persisting the choice", async () => {
    mocks.getOnboardingSyncSession.mockResolvedValue(view());

    renderBanner();

    await screen.findByLabelText("首次数据同步状态");
    expect(screen.getByText("近期数据（活动 / 健康）")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("onboarding-sync-banner-toggle"));
    expect(screen.queryByText("近期数据（活动 / 健康）")).not.toBeInTheDocument();
    expect(localStorage.getItem("stride.onboarding-sync-banner.collapsed")).toBe("1");

    fireEvent.click(screen.getByTestId("onboarding-sync-banner-toggle"));
    expect(screen.getByText("近期数据（活动 / 健康）")).toBeInTheDocument();
  });
});
