import { describe, expect, it } from "vitest";
import type { OnboardingSyncView } from "../../api";
import { expectedEmptyScan, gapText, historicalAnalysisLabel, shouldPollSession, isSessionTerminal, rangeLabel, readinessLabel, sessionStateLabel, shouldHideBanner } from "../sessionModel";

function view(overrides: Partial<OnboardingSyncView>): OnboardingSyncView {
  return {
    session_id: "sess-1",
    state: "running",
    shell_ready: true,
    provider: "coros",
    binding_revision: 1,
    anchor_day: "2026-11-17",
    retry_count: 0,
    stages: [],
    readiness: {
      shell_ready: true,
      recent_data: "running",
      recent_analysis: "pending",
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

describe("sessionModel", () => {
  it("treats completed / completed_with_gaps / failed / superseded as terminal", () => {
    for (const state of ["completed", "completed_with_gaps", "failed", "superseded"]) {
      expect(isSessionTerminal(state)).toBe(true);
    }
    for (const state of ["waiting_legacy", "dispatching", "running"]) {
      expect(isSessionTerminal(state)).toBe(false);
    }
  });

  it("hides the banner for completed/superseded sessions and after dismissal", () => {
    expect(shouldHideBanner(null, false)).toBe(true);
    expect(shouldHideBanner(view({ state: "completed" }), false)).toBe(true);
    expect(shouldHideBanner(view({ state: "superseded" }), false)).toBe(true);
    expect(shouldHideBanner(view({ state: "running" }), false)).toBe(false);
    // failed and completed_with_gaps stay visible: error retry / gap honesty.
    expect(shouldHideBanner(view({ state: "failed" }), false)).toBe(false);
    expect(shouldHideBanner(view({ state: "completed_with_gaps" }), false)).toBe(false);
    expect(shouldHideBanner(view({ state: "failed" }), true)).toBe(true);
  });

  it("labels readiness levels without ever presenting gaps as full coverage", () => {
    expect(readinessLabel("ready")).toBe("已就绪");
    expect(readinessLabel("ready_with_gaps")).toBe("已就绪（有缺项）");
    expect(readinessLabel("partial")).toBe("部分可用");
    expect(readinessLabel("unavailable")).toBe("暂不可用");
    expect(readinessLabel("not_started")).toBe("未开始");
    expect(sessionStateLabel("completed_with_gaps")).toBe("同步完成（部分缺项）");
    expect(sessionStateLabel("waiting_legacy")).toBe("接管已有同步任务");
  });

  it("renders open range ends when a scan has not observed bounds yet", () => {
    expect(rangeLabel("2026-08-19", "2026-11-17")).toBe("2026-08-19 ~ 2026-11-17");
    expect(rangeLabel(null, null)).toBe("—");
    expect(rangeLabel("2026-08-19", null)).toBe("2026-08-19 ~ …");
  });
});

it("keeps historical analysis visible after raw sync and stops polling when it needs intervention", () => {
  const base = view({ state: "completed" });
  const pending = { ...base, historical_analysis_poll: true, readiness: { ...base.readiness, historical_analysis: "pending" as const } };
  expect(shouldHideBanner(pending, false)).toBe(false);
  expect(shouldPollSession(pending)).toBe(true);
  expect(historicalAnalysisLabel(pending)).toBe("待处理");
  const paused = { ...pending, historical_analysis_poll: false, historical_analysis_reason: "interruption_limit" };
  expect(shouldPollSession(paused)).toBe(false);
  expect(historicalAnalysisLabel(paused)).toBe("待人工处理");
  expect(historicalAnalysisLabel({ ...base, readiness: { ...base.readiness, historical_analysis: "ready_with_gaps" } })).toBe("已就绪（有缺项）");
});

it("shows COROS history limits as a finished scan and distinguishes retryable dates from rejected records", () => {
  const history = { from: "2026-09-01", to: "2026-09-05", kind: "empty" as const, channel: "health", health_history_days: 72 };
  const session = view({ state: "completed", stages: [{
    stage: "extended_raw", status: "completed", readiness: "ready_with_gaps",
    target_from: "2026-09-01", target_to: "2026-11-16", gaps: [history],
  }] });
  expect(shouldHideBanner(session, false)).toBe(false);
  expect(expectedEmptyScan(session.stages[0])).toBe(true);
  expect(gapText(history)).toBe("手表只提供近 72 天健康数据 · 2026-09-01 ~ 2026-09-05");
  expect(gapText({ from: "2026-11-15", to: "2026-11-16", kind: "transient" })).toContain("有 2 天数据暂时拿不到");
  expect(gapText({ from: "2026-11-16", to: "2026-11-16", kind: "unavailable", reason: "activity 42 was deleted" })).toContain("有 1 条记录无法获取 · 2026-11-16（activity 42 was deleted）");
});
