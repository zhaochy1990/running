import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createTrainingGoal: vi.fn(),
  generateMasterPlan: vi.fn(),
  getMasterPlanJob: vi.fn(),
  getPipelineRun: vi.fn(),
  triggerSync: vi.fn(),
}));

vi.mock("../../api", () => api);
vi.mock("../../UserContextValue", () => ({
  useUser: () => ({ user: "user-1" }),
}));

import TrainingPlanSetup from "../TrainingPlanSetup";

const run = (runId: string, status: "queued" | "running" | "done" | "failed") => ({
  run_id: runId,
  pipeline_name: "data_sync",
  status,
  current_step: status === "done" ? 2 : 0,
  steps: [],
  ...(status === "failed" ? { error_message: "sync failed" } : {}),
});

const job = (status: "queued" | "running" | "done" | "failed", planId: string | null = null) => ({
  status,
  stage: null,
  progress: status === "done" ? 100 : 20,
  stage_label: status === "done" ? "已完成" : "正在生成",
  context: null,
  result_plan_id: planId,
  error: status === "failed" ? "generation failed" : null,
});

function renderSetup(onDraftReady = vi.fn()) {
  return render(<TrainingPlanSetup onDraftReady={onDraftReady} />);
}

async function submitGoal() {
  fireEvent.click(screen.getByRole("button", { name: "5K" }));
  fireEvent.change(screen.getByLabelText("目标赛事"), { target: { value: "测试比赛" } });
  fireEvent.change(screen.getByLabelText("比赛日期"), { target: { value: "2026-12-06" } });
  fireEvent.click(screen.getByRole("button", { name: /^5$/ }));
  await vi.waitFor(() => {
    expect(screen.getByRole("button", { name: "5K" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^5$/ })).toHaveAttribute("aria-pressed", "true");
  });
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: "生成我的赛季计划" }).closest("form")!);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(api.createTrainingGoal).toHaveBeenCalledTimes(1);
  expect(api.triggerSync).toHaveBeenCalledTimes(1);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function pollOnce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.createTrainingGoal.mockResolvedValue({ ok: true, status: 201, data: { goal_id: "goal-1" } });
  api.triggerSync.mockResolvedValue({ ok: true, status: 202, data: { run_id: "run-1", pipeline_name: "data_sync" } });
  api.getPipelineRun.mockResolvedValue(run("run-1", "running"));
  api.generateMasterPlan.mockResolvedValue({ ok: true, status: 202, data: { job_id: "job-1", status: "queued", eta_seconds: 10 } });
  api.getMasterPlanJob.mockResolvedValue(job("running"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TrainingPlanSetup polling", () => {
  it("starts generation after sync and reaches the ready state on success", async () => {
    api.getPipelineRun.mockResolvedValue(run("run-1", "done"));
    api.getMasterPlanJob.mockResolvedValue(job("done", "plan-1"));
    const onDraftReady = vi.fn();

    renderSetup(onDraftReady);
    await submitGoal();
    await pollOnce();

    expect(api.generateMasterPlan).toHaveBeenCalledWith("goal-1");
    await pollOnce();
    expect(screen.getByText("赛季计划草稿已准备好")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看计划" }));
    expect(onDraftReady).toHaveBeenCalledWith("plan-1");
  });

  it("rejects a non-incremental pipeline before polling", async () => {
    api.triggerSync.mockResolvedValue({
      ok: true,
      status: 202,
      data: { run_id: "run-1", pipeline_name: "onboarding" },
    });

    renderSetup();
    await submitGoal();

    expect(screen.getByText("无法完成历史数据同步")).toBeInTheDocument();
    expect(api.getPipelineRun).not.toHaveBeenCalled();
    expect(api.generateMasterPlan).not.toHaveBeenCalled();
  });

  it("rejects a polled run whose pipeline identity changes", async () => {
    api.getPipelineRun.mockResolvedValue({ ...run("run-1", "done"), pipeline_name: "onboarding" });

    renderSetup();
    await submitGoal();
    await pollOnce();

    expect(screen.getByText("无法完成历史数据同步")).toBeInTheDocument();
    expect(api.generateMasterPlan).not.toHaveBeenCalled();
  });

  it("shows sync failure and does not start generation", async () => {
    api.getPipelineRun.mockResolvedValue(run("run-1", "failed"));

    renderSetup();
    await submitGoal();
    await pollOnce();

    expect(screen.getByText("无法完成历史数据同步")).toBeInTheDocument();
    expect(api.generateMasterPlan).not.toHaveBeenCalled();
  });

  it("invalidates a timed-out sync so a late done response cannot start generation", async () => {
    let resolveOldRun!: (value: ReturnType<typeof run>) => void;
    const oldRun = new Promise<ReturnType<typeof run>>((resolve) => {
      resolveOldRun = resolve;
    });
    api.getPipelineRun.mockImplementation(() => oldRun);
    api.triggerSync.mockResolvedValueOnce({ ok: true, status: 202, data: { run_id: "run-2", pipeline_name: "data_sync" } });

    renderSetup();
    await submitGoal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(901 * 1500);
    });

    expect(screen.getByText("无法完成历史数据同步")).toBeInTheDocument();
    expect(api.generateMasterPlan).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新同步" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(api.triggerSync).toHaveBeenCalledTimes(2));
    api.getPipelineRun.mockResolvedValue(run("run-2", "running"));
    resolveOldRun(run("run-1", "done"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.generateMasterPlan).not.toHaveBeenCalled();
  });

  it("uses a fresh idempotency key and run on retry", async () => {
    api.triggerSync
      .mockResolvedValueOnce({ ok: true, status: 202, data: { run_id: "run-1", pipeline_name: "data_sync" } })
      .mockResolvedValueOnce({ ok: true, status: 202, data: { run_id: "run-2", pipeline_name: "data_sync" } });
    api.getPipelineRun.mockResolvedValueOnce(run("run-1", "failed")).mockResolvedValue(run("run-2", "running"));

    renderSetup();
    await submitGoal();
    await pollOnce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新同步" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(api.triggerSync).toHaveBeenCalledTimes(2));

    const firstOptions = api.triggerSync.mock.calls[0][1];
    const secondOptions = api.triggerSync.mock.calls[1][1];
    expect(firstOptions.idempotencyKey).not.toBe(secondOptions.idempotencyKey);
    await pollOnce();
    expect(api.getPipelineRun).toHaveBeenLastCalledWith("run-2");
  });

  it("only starts generation for a done sync response", async () => {
    api.getPipelineRun.mockResolvedValueOnce(run("run-1", "running")).mockResolvedValueOnce(run("run-1", "done"));

    renderSetup();
    await submitGoal();
    await pollOnce();
    expect(api.generateMasterPlan).not.toHaveBeenCalled();

    await pollOnce();
    expect(api.generateMasterPlan).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale generation response after timeout and retry", async () => {
    api.getPipelineRun.mockResolvedValue(run("run-1", "done"));
    let resolveOldJob!: (value: ReturnType<typeof job>) => void;
    const oldJob = new Promise<ReturnType<typeof job>>((resolve) => {
      resolveOldJob = resolve;
    });
    api.getMasterPlanJob.mockImplementationOnce(() => oldJob).mockResolvedValue(job("running"));

    const onDraftReady = vi.fn();
    renderSetup(onDraftReady);
    await submitGoal();
    await pollOnce();
    expect(api.generateMasterPlan).toHaveBeenCalledWith("goal-1");
    await pollOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400 * 1500);
    });
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(api.generateMasterPlan).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    api.getMasterPlanJob.mockResolvedValueOnce(job("done", "plan-2"));
    resolveOldJob(job("done", "plan-1"));
    await pollOnce();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("赛季计划草稿已准备好")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看计划" }));
    expect(onDraftReady).toHaveBeenCalledWith("plan-2");
    expect(onDraftReady).not.toHaveBeenCalledWith("plan-1");
  });
});
