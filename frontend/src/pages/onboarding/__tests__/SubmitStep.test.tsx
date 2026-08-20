import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPipelineRun: vi.fn(),
  getJobState: vi.fn(),
  postOnboardingComplete: vi.fn(),
  triggerSync: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../../../api", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;

    constructor(status: number) {
      super(`API error: ${status}`);
      this.status = status;
    }
  },
  getPipelineRun: mocks.getPipelineRun,
  getJobState: mocks.getJobState,
  postOnboardingComplete: mocks.postOnboardingComplete,
  triggerSync: mocks.triggerSync,
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mocks.navigate };
});

import SubmitStep from "../SubmitStep";

const runningRun = {
  run_id: "run-1",
  pipeline_name: "onboarding",
  status: "running" as const,
  current_step: 0,
  steps: [
    { name: "sync", job_type: "sync", status: "running", job_id: "job-1" },
    { name: "calibration", job_type: "calibration", status: "queued" },
    { name: "compute", job_type: "compute", status: "queued" },
  ],
};

const doneRun = {
  ...runningRun,
  status: "done" as const,
  current_step: 2,
  steps: runningRun.steps.map((step) => ({ ...step, status: "done" })),
};

function renderStep() {
  return render(
    <MemoryRouter>
      <SubmitStep userId="user-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mocks.getPipelineRun.mockReset();
  mocks.getJobState.mockReset();
  mocks.postOnboardingComplete.mockReset();
  mocks.triggerSync.mockReset();
  mocks.navigate.mockReset();
});

describe("SubmitStep", () => {
  it("automatically creates and polls a full onboarding pipeline", async () => {
    mocks.triggerSync.mockResolvedValue({ ok: true, status: 202, data: { run_id: "run-1", pipeline_name: "onboarding" } });
    mocks.getPipelineRun.mockResolvedValue(runningRun);
    mocks.getJobState.mockResolvedValue({ job_id: "job-1", status: "running", progress_pct: 42 });

    renderStep();

    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledWith("user-1", expect.objectContaining({ full: true, idempotencyKey: expect.any(String) })));
    expect(screen.queryByRole("button", { name: /开始使用|开始同步/i })).not.toBeInTheDocument();
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBe("run-1");
    expect(localStorage.getItem("stride:onboarding-start-key:user-1")).toBeNull();

    expect(mocks.getPipelineRun).toHaveBeenCalledWith("run-1");
    expect(screen.getByText("同步数据")).toBeInTheDocument();
    expect(await screen.findByLabelText("同步数据进度 42%")).toBeInTheDocument();
  });

  it("uses a valid saved run rather than starting a duplicate run", async () => {
    localStorage.setItem("stride:onboarding-run:user-1", "saved-run");
    mocks.getPipelineRun.mockResolvedValue(runningRun);

    renderStep();

    await waitFor(() => expect(mocks.getPipelineRun).toHaveBeenCalledWith("saved-run"));
    expect(mocks.triggerSync).not.toHaveBeenCalled();
  });

  it("refreshes the pipeline only after the active job completes", async () => {
    localStorage.setItem("stride:onboarding-run:user-1", "run-1");
    mocks.getPipelineRun.mockResolvedValueOnce(runningRun).mockResolvedValueOnce({
      ...runningRun,
      current_step: 1,
      steps: [{ ...runningRun.steps[0], status: "done" }, { ...runningRun.steps[1], status: "running", job_id: "job-2" }, runningRun.steps[2]],
    });
    mocks.getJobState
      .mockResolvedValueOnce({ job_id: "job-1", status: "done", progress_pct: 100 })
      .mockResolvedValueOnce({ job_id: "job-2", status: "running", progress_pct: 60 });

    renderStep();

    await waitFor(() => expect(mocks.getJobState).toHaveBeenCalledWith("job-1"));
    await waitFor(() => expect(mocks.getPipelineRun).toHaveBeenCalledTimes(2));
    await screen.findByLabelText("校准训练基线进度 60%");
    expect(mocks.getPipelineRun).toHaveBeenCalledTimes(2);
  });

  it("discards a confirmed missing saved run and starts a new full run", async () => {
    localStorage.setItem("stride:onboarding-run:user-1", "old-run");
    const missing = Object.assign(new Error("API error: 404"), { status: 404 });
    mocks.getPipelineRun.mockRejectedValueOnce(missing);
    mocks.triggerSync.mockResolvedValue({ ok: true, status: 202, data: { run_id: "new-run", pipeline_name: "onboarding" } });
    mocks.getPipelineRun.mockResolvedValue(runningRun);

    renderStep();

    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledWith("user-1", expect.objectContaining({ full: true, idempotencyKey: expect.any(String) })));
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBe("new-run");
  });

  it("keeps polling a saved run after an initial transient fetch failure", async () => {
    localStorage.setItem("stride:onboarding-run:user-1", "saved-run");
    mocks.getPipelineRun.mockRejectedValueOnce(new Error("network interrupted")).mockResolvedValueOnce({ ...runningRun, run_id: "saved-run" });

    renderStep();

    await waitFor(() => expect(mocks.getPipelineRun).toHaveBeenCalledTimes(1));
    expect(mocks.triggerSync).not.toHaveBeenCalled();
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBe("saved-run");

    await waitFor(() => expect(mocks.getPipelineRun).toHaveBeenCalledTimes(2), { timeout: 6_500 });
    expect(mocks.triggerSync).not.toHaveBeenCalled();
  }, 7_000);

  it("keeps polling an active job after a transient refresh failure", async () => {
    localStorage.setItem("stride:onboarding-run:user-1", "saved-run");
    mocks.getPipelineRun.mockResolvedValueOnce({ ...runningRun, run_id: "saved-run" });
    mocks.getJobState.mockRejectedValueOnce(new Error("service unavailable")).mockResolvedValueOnce({ job_id: "job-1", status: "running", progress_pct: 50 });

    renderStep();

    await waitFor(() => expect(mocks.getPipelineRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.getJobState).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(mocks.getPipelineRun).toHaveBeenCalledTimes(1);
    expect(mocks.triggerSync).not.toHaveBeenCalled();
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBe("saved-run");
  }, 10_000);

  it("reuses a persisted start key after an ambiguous start failure", async () => {
    const startKey = "persisted-start-key";
    localStorage.setItem("stride:onboarding-start-key:user-1", startKey);
    mocks.triggerSync
      .mockRejectedValueOnce(new Error("network interrupted"))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { run_id: "recovered-run", pipeline_name: "onboarding", deduplicated: true } });
    mocks.getPipelineRun.mockResolvedValue(runningRun);

    renderStep();
    await screen.findByRole("button", { name: "重新同步" });
    expect(localStorage.getItem("stride:onboarding-start-key:user-1")).toBe(startKey);

    fireEvent.click(screen.getByRole("button", { name: "重新同步" }));
    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledTimes(2));
    expect(mocks.triggerSync.mock.calls[0]).toEqual(["user-1", { full: true, idempotencyKey: startKey }]);
    expect(mocks.triggerSync.mock.calls[1]).toEqual(["user-1", { full: true, idempotencyKey: startKey }]);
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBe("recovered-run");
    expect(localStorage.getItem("stride:onboarding-start-key:user-1")).toBeNull();
  });

  it("discards an async start result after the account switches", async () => {
    let resolveFirst!: (value: { ok: boolean; status: number; data: { run_id: string; pipeline_name: string } }) => void;
    mocks.triggerSync
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, status: 202, data: { run_id: "user-2-run", pipeline_name: "onboarding" } });
    mocks.getPipelineRun.mockResolvedValue(runningRun);

    const view = render(
      <MemoryRouter>
        <SubmitStep userId="user-1" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledTimes(1));
    view.rerender(
      <MemoryRouter>
        <SubmitStep userId="user-2" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledWith("user-2", expect.objectContaining({ full: true })));

    resolveFirst({ ok: true, status: 202, data: { run_id: "user-1-run", pipeline_name: "onboarding" } });
    await waitFor(() => expect(localStorage.getItem("stride:onboarding-run:user-2")).toBe("user-2-run"));
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBeNull();
    expect(mocks.getPipelineRun).not.toHaveBeenCalledWith("user-1-run");
  });

  it("keeps completion explicit and finalizes only after Enter STRIDE succeeds", async () => {
    localStorage.setItem("stride:onboarding-run:user-1", "run-1");
    mocks.getPipelineRun.mockResolvedValue(doneRun);
    mocks.postOnboardingComplete.mockResolvedValue({ ok: true, status: 200, data: { state: "complete" } });

    renderStep();

    const enter = await screen.findByRole("button", { name: "Enter STRIDE" });
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(enter);

    await waitFor(() => expect(mocks.postOnboardingComplete).toHaveBeenCalledWith("run-1"));
    expect(mocks.navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(localStorage.getItem("stride:onboarding-run:user-1")).toBeNull();
  });

  it("shows finalization failure without leaving the completed state", async () => {
    localStorage.setItem("stride:onboarding-run:user-1", "run-1");
    mocks.getPipelineRun.mockResolvedValue(doneRun);
    mocks.postOnboardingComplete.mockResolvedValue({ ok: false, status: 500, data: { error: "service unavailable" } });

    renderStep();

    fireEvent.click(await screen.findByRole("button", { name: "Enter STRIDE" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("service unavailable");
    expect(screen.getByRole("button", { name: "Enter STRIDE" })).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
