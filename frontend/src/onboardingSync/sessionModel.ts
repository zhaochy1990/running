// Pure helpers over the first-sync session view (devops#1014 / epic
// devops#1004 T10). The view comes from GET /users/me/onboarding/sync and is
// DERIVED server-side — these helpers only shape it for display and decide
// polling/banner visibility, they never infer readiness beyond what the
// server reports (completed_with_gaps is NOT full coverage and must not be
// presented as such).
import type { OnboardingSyncReadiness, OnboardingSyncStageGap, OnboardingSyncStageView, OnboardingSyncView } from "../api";

// Session states (server-owned, see internal/storage/onboardingsync.go).
export type OnboardingSyncState =
  | "waiting_legacy"
  | "dispatching"
  | "running"
  | "completed"
  | "completed_with_gaps"
  | "failed"
  | "superseded";

export const SESSION_POLL_MS = 5000;

export function sessionStateLabel(state: string): string {
  switch (state) {
    case "waiting_legacy":
      return "接管已有同步任务";
    case "dispatching":
      return "正在启动同步";
    case "running":
      return "同步进行中";
    case "failed":
      return "同步失败";
    case "completed_with_gaps":
      return "同步完成（部分缺项）";
    case "completed":
      return "同步完成";
    case "superseded":
      return "已由新绑定取代";
    default:
      return state;
  }
}

// Terminal = the session chain will not advance on its own anymore. The
// banner keeps showing failed / completed_with_gaps (error + retry, gaps);
// completed / superseded are hidden.
export function isSessionTerminal(state: string): boolean {
  return state === "completed" || state === "completed_with_gaps" || state === "failed" || state === "superseded";
}

export function shouldHideBanner(view: OnboardingSyncView | null, dismissed: boolean): boolean {
  if (!view || dismissed) return true;
  return view.state === "superseded" || (view.state === "completed" && view.readiness.historical_analysis === "not_started" &&
    !view.stages.some((stage) => stage.gaps?.some((gap) => gap.health_history_days)));
}

export function shouldPollSession(view: OnboardingSyncView): boolean {
  return !isSessionTerminal(view.state) || view.historical_analysis_poll === true;
}

export function historicalAnalysisLabel(view: OnboardingSyncView): string {
  if (view.historical_analysis_reason) return "待人工处理";
  return view.readiness.historical_analysis === "pending" ? "待处理" : readinessLabel(view.readiness.historical_analysis);
}

export function readinessLabel(level: OnboardingSyncReadiness): string {
  switch (level) {
    case "ready":
      return "已就绪";
    case "ready_with_gaps":
      return "已就绪（有缺项）";
    case "running":
      return "进行中";
    case "pending":
      return "等待中";
    case "failed":
      return "失败";
    case "partial":
      return "部分可用";
    case "unavailable":
      return "暂不可用";
    default:
      return "未开始";
  }
}

export function readinessTone(level: OnboardingSyncReadiness): "good" | "warn" | "bad" | "muted" {
  switch (level) {
    case "ready":
      return "good";
    case "ready_with_gaps":
    case "partial":
      return "warn";
    case "failed":
      return "bad";
    case "running":
    case "pending":
    case "unavailable":
      return "muted";
    default:
      return "muted";
  }
}

// The summary chips shown in the banner header (spec: 原始/派生/辅助分开，
// 历史失败不收回近期)。shell_ready (bool) is deliberately not a chip.
export type ReadinessKey = Exclude<keyof OnboardingSyncView["readiness"], "shell_ready">;

export const READINESS_SUMMARY: Array<{ key: ReadinessKey; label: string }> = [
  { key: "recent_data", label: "近期数据" },
  { key: "recent_analysis", label: "近期分析" },
  { key: "extended_data", label: "历史扩展" },
  { key: "historical_data", label: "历史补齐" },
  { key: "historical_analysis", label: "历史分析" },
  { key: "auxiliary", label: "辅助任务" },
];

const STAGE_LABELS: Record<string, string> = {
  recent_raw: "近期数据（活动 / 健康）",
  recent_analysis: "近期分析",
  extended_raw: "历史扩展（180日活动 / 90日健康）",
  historical_raw: "历史补齐（全部可访问活动）",
  auxiliary: "辅助任务（比赛识别 / 路线形状）",
};

export function stageLabel(stage: OnboardingSyncStageView): string {
  return STAGE_LABELS[stage.stage] ?? stage.stage;
}

// "2026-11-10 ~ 2026-11-16" from optional observed bounds; omitted bounds
// render as open ends so an unfinished scan never reads as full coverage.
export function rangeLabel(from?: string | null, to?: string | null): string {
  if (!from && !to) return "—";
  return `${from ?? "…"} ~ ${to ?? "…"}`;
}

export function expectedEmptyScan(stage: OnboardingSyncStageView | undefined): boolean {
  return stage?.status === "completed" && Boolean(stage.gaps?.length) && stage.gaps?.every((gap) => gap.kind === "empty") === true;
}

const RAW_STAGES = {
  recent_data: "recent_raw",
  extended_data: "extended_raw",
  historical_data: "historical_raw",
} as const;

export function summaryStage(view: OnboardingSyncView, key: ReadinessKey): OnboardingSyncStageView | undefined {
  if (key === "historical_data") {
    return view.stages.find((stage) => stage.stage === "historical_raw") ?? view.stages.find((stage) => stage.stage === "extended_raw");
  }
  if (key === "recent_data" || key === "extended_data") {
    return view.stages.find((stage) => stage.stage === RAW_STAGES[key]);
  }
  return undefined;
}

export function gapText(gap: OnboardingSyncStageGap): string {
  const range = gap.from === gap.to ? gap.from : rangeLabel(gap.from, gap.to);
  const reason = gap.reason ? `（${gap.reason}）` : "";
  if (gap.kind === "empty") {
    if (gap.health_history_days) return `手表只提供近 ${gap.health_history_days} 天健康数据 · ${range}`;
    const item = gap.channel === "health" ? "健康记录" : gap.channel === "dashboard" ? "手表摘要" : "训练记录";
    return `这段时间没有${item} · ${range}`;
  }
  if (gap.kind === "transient") {
    const days = Math.round((Date.parse(gap.to) - Date.parse(gap.from)) / 86_400_000) + 1;
    return `${days > 0 && !gap.range_estimated ? `有 ${days} 天数据暂时拿不到` : "数据暂时拿不到"} · ${range}`;
  }
  if (gap.kind === "unavailable") {
    const label = gap.reason?.startsWith("activity ") ? "有 1 条记录无法获取" : "这段时间的数据无法获取";
    return `${label} · ${range}${reason}`;
  }
  return `缺项：${rangeLabel(gap.from, gap.to)}${reason}`;
}
