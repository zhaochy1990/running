import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postOnboardingSyncSession: vi.fn(),
  getOnboardingSyncSession: vi.fn(),
  postOnboardingComplete: vi.fn(),
  navigate: vi.fn(),
  onDisabled: vi.fn(),
}));

vi.mock("../../../api", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number) {
      super(`API error: ${status}`);
      this.status = status;
    }
  },
  postOnboardingSyncSession: mocks.postOnboardingSyncSession,
  getOnboardingSyncSession: mocks.getOnboardingSyncSession,
  postOnboardingComplete: mocks.postOnboardingComplete,
}));

// Real timers with a 10ms poll keep the adoption test deterministic without
// fake-timer/act interleaving.
vi.mock("../../../onboardingSync/sessionModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../onboardingSync/sessionModel")>();
  return { ...actual, SESSION_POLL_MS: 10 };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mocks.navigate };
});

import SessionSubmitStep from "../SessionSubmitStep";

function view(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess-1",
    state: "dispatching",
    shell_ready: true,
    provider: "coros",
    binding_revision: 1,
    anchor_day: "2026-11-17",
    retry_count: 0,
    stages: [],
    readiness: {
      shell_ready: true,
      recent_data: "pending",
      recent_analysis: "not_started",
      extended_data: "not_started",
      historical_data: "not_started",
      historical_analysis: "not_started",
      auxiliary: "not_started",
    },
    created_at: "2026-11-17T00:00:00Z",
    updated_at: "2026-11-17T00:00:00Z",
    ...overrides,
  };
}

function renderStep() {
  return render(
    <MemoryRouter>
      <SessionSubmitStep userId="user-1" onDisabled={mocks.onDisabled} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("SessionSubmitStep", () => {
  it("creates the session, completes profile-only and enters home once shell_ready", async () => {
    localStorage.clear();
    mocks.postOnboardingSyncSession.mockResolvedValue({ ok: true, status: 200, data: view() });
    mocks.postOnboardingComplete.mockResolvedValue({ ok: true, status: 200, data: { state: "complete" } });

    renderStep();

    await waitFor(() => expect(mocks.postOnboardingSyncSession).toHaveBeenCalledWith(false));
    // Profile-only completion: no run_id is submitted to the legacy finalizer.
    await waitFor(() => expect(mocks.postOnboardingComplete).toHaveBeenCalledTimes(1));
    expect(mocks.postOnboardingComplete.mock.calls[0]).toHaveLength(0);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true }));
    // The session flow keeps no local full-run pointers (换设备不重建).
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBeNull();
    expect(localStorage.getItem("stride:onboarding-start-key:user-1")).toBeNull();
  });

  it("reports creation failure honestly and retries the create", async () => {
    mocks.postOnboardingSyncSession
      .mockResolvedValueOnce({ ok: false, status: 500, data: { error: "internal error" } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: view() });
    mocks.postOnboardingComplete.mockResolvedValue({ ok: true, status: 200, data: { state: "complete" } });

    renderStep();

    expect(await screen.findByText("同步任务创建失败")).toBeInTheDocument();
    expect(screen.getByText("后台没有正在运行的同步任务，不会重复导入数据。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试创建" }));

    await waitFor(() => expect(mocks.postOnboardingSyncSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true }));
  });

  it("surfaces no_watch_provider as a bind-step hint instead of a generic error", async () => {
    mocks.postOnboardingSyncSession.mockResolvedValue({ ok: false, status: 409, data: { error: "no_watch_provider" } });

    renderStep();

    expect(await screen.findByText("尚未绑定手表，请返回上一步完成绑定。")).toBeInTheDocument();
    expect(mocks.postOnboardingComplete).not.toHaveBeenCalled();
  });

  it("falls back to the legacy flow when the server answers 403", async () => {
    mocks.postOnboardingSyncSession.mockResolvedValue({ ok: false, status: 403, data: { error: "sync_disabled" } });

    renderStep();

    await waitFor(() => expect(mocks.onDisabled).toHaveBeenCalledTimes(1));
    expect(mocks.postOnboardingComplete).not.toHaveBeenCalled();
  });

  it("falls back to the legacy flow when the session POST transport-fails with 403", async () => {
    const { ApiError } = await import("../../../api");
    mocks.postOnboardingSyncSession.mockRejectedValue(new ApiError(403));

    renderStep();

    await waitFor(() => expect(mocks.onDisabled).toHaveBeenCalledTimes(1));
  });

  it("keeps completion retryable when entering the app fails", async () => {
    mocks.postOnboardingSyncSession.mockResolvedValue({ ok: true, status: 200, data: view() });
    mocks.postOnboardingComplete.mockResolvedValue({ ok: false, status: 409, data: { error: "onboarding run is not ready" } });

    renderStep();

    const alert = await screen.findByRole("alert");
    // Server error strings surface as-is (parity with the legacy flow).
    expect(alert.textContent).toContain("onboarding run is not ready");
    expect(mocks.navigate).not.toHaveBeenCalled();

    mocks.postOnboardingComplete.mockResolvedValue({ ok: true, status: 200, data: { state: "complete" } });
    fireEvent.click(screen.getByRole("button", { name: "重试进入 STRIDE" }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true }));
  });

  it("adopts a not-yet-persisted session by polling the read-only view until shell_ready", async () => {
    mocks.postOnboardingSyncSession.mockResolvedValue({ ok: true, status: 200, data: view({ shell_ready: false, state: "waiting_legacy" }) });
    mocks.getOnboardingSyncSession
      .mockResolvedValueOnce(view({ shell_ready: false, state: "waiting_legacy" }))
      .mockResolvedValueOnce(view({ shell_ready: true, state: "dispatching" }));
    mocks.postOnboardingComplete.mockResolvedValue({ ok: true, status: 200, data: { state: "complete" } });

    renderStep();

    expect(await screen.findByText("正在接管已有的首次同步任务，进度不会丢失。")).toBeInTheDocument();
    expect(mocks.postOnboardingComplete).not.toHaveBeenCalled();

    await waitFor(() => expect(mocks.getOnboardingSyncSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true }));
  }, 10_000);
});
