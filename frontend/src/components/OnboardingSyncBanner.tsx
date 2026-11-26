import { useState } from "react";
import { Link } from "react-router-dom";
import type { OnboardingSyncReadiness } from "../api";
import { useOnboardingSyncStatus } from "../onboardingSync/OnboardingSyncStatusContext";
import { READINESS_SUMMARY, historicalAnalysisLabel, isSessionTerminal, rangeLabel, readinessLabel, readinessTone, sessionStateLabel, shouldHideBanner, stageLabel } from "../onboardingSync/sessionModel";

// Global, collapsible first-sync banner (devops#1014 T10): rendered once in
// the app layout so the home / training / activities pages all show the same
// server-derived progress. Recent details are reachable as soon as
// recent_data reports ready — a later historical failure never retracts them.
const COLLAPSED_KEY = "stride.onboarding-sync-banner.collapsed";

const TONE_CLASSES: Record<ReturnType<typeof readinessTone>, string> = {
  good: "border-accent-green/40 bg-accent-green/10 text-accent-green",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  bad: "border-red-500/40 bg-red-500/10 text-red-400",
  muted: "border-border-subtle bg-bg-card text-text-muted",
};

function ReadinessChip({ label, level, text }: { label: string; level: OnboardingSyncReadiness; text?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-none ${TONE_CLASSES[readinessTone(level)]}`}>
      <span className="text-text-muted">{label}</span>
      <span className="font-medium">{text ?? readinessLabel(level)}</span>
    </span>
  );
}

export default function OnboardingSyncBanner() {
  const { view, retry, retrying, retryError, dismiss, dismissed } = useOnboardingSyncStatus();
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) !== "1";
    } catch {
      return true;
    }
  });

  if (shouldHideBanner(view, dismissed)) return null;
  const v = view!;
  const failed = v.state === "failed";
  const gapsTerminal = v.state === "completed_with_gaps";
  const recentReady = v.readiness.recent_data === "ready" || v.readiness.recent_data === "ready_with_gaps";

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "0" : "1");
      } catch {
        /* collapse is a nicety, not a requirement */
      }
      return next;
    });
  };

  return (
    <section
      aria-label="首次数据同步状态"
      className={`border-b px-4 py-2.5 text-sm ${failed ? "border-red-500/30 bg-red-500/5" : gapsTerminal ? "border-amber-500/30 bg-amber-500/5" : "border-border-subtle bg-bg-card"}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${failed ? "bg-red-400" : gapsTerminal ? "bg-amber-400" : isSessionTerminal(v.state) && !v.historical_analysis_poll ? "bg-accent-green" : "animate-pulse bg-accent-green"}`}
        />
        <p className="font-medium text-text-primary">
          首次数据同步 <span className="text-text-muted">· {sessionStateLabel(v.state)}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {READINESS_SUMMARY.map(({ key, label }) => (
            <ReadinessChip key={key} label={label} level={v.readiness[key]} text={key === "historical_analysis" ? historicalAnalysisLabel(v) : undefined} />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {recentReady && (
            <Link to="/activities" className="text-xs text-accent-green underline underline-offset-2 hover:text-accent-green/80">
              查看近期活动
            </Link>
          )}
          {failed && (
            <button
              type="button"
              onClick={() => void retry()}
              disabled={retrying}
              className="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              {retrying ? "重试中..." : "重试失败项"}
            </button>
          )}
          {isSessionTerminal(v.state) && (
            <button type="button" onClick={dismiss} className="text-xs text-text-muted underline underline-offset-2 hover:text-text-primary">
              忽略
            </button>
          )}
          <button
            type="button"
            onClick={toggle}
            aria-expanded={expanded}
            className="text-xs text-text-muted hover:text-text-primary"
            data-testid="onboarding-sync-banner-toggle"
          >
            {expanded ? "收起" : "展开"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2">
          {(failed || v.error) && (
            <p role="alert" className="text-xs text-red-400">
              {v.error || "部分同步任务失败，已完成的范围不会丢失。"}
            </p>
          )}
          {v.historical_analysis_reason && (
            <p className="text-xs text-amber-400">
              {v.historical_analysis_reason === "interruption_limit" ? "历史分析多次被新数据打断，等待人工处理。" : "历史分析重算失败，等待人工处理。"}
            </p>
          )}
          {retryError && (
            <p role="alert" className="text-xs text-red-400">
              {retryError}
            </p>
          )}
          <ul className="space-y-1.5" aria-label="同步阶段详情">
            {v.stages.map((stage) => (
              <li key={stage.stage} className="rounded border border-border-subtle bg-bg-base px-2.5 py-1.5">
                <div className="flex flex-wrap items-center justify-between gap-x-3">
                  <p className="text-xs font-medium text-text-primary">{stageLabel(stage)}</p>
                  <p className={`text-[11px] ${TONE_CLASSES[readinessTone(stage.readiness)]} rounded border px-1.5 py-0.5`}>{readinessLabel(stage.readiness)}</p>
                </div>
                <p className="mt-1 text-[11px] text-text-muted">
                  目标范围 {rangeLabel(stage.target_from, stage.target_to)}
                  {stage.observed_from || stage.observed_to ? ` · 实际覆盖 ${rangeLabel(stage.observed_from, stage.observed_to)}` : " · 实际覆盖 —"}
                </p>
                {stage.gaps && stage.gaps.length > 0 && (
                  <p className="mt-0.5 text-[11px] text-amber-400">
                    缺项：{stage.gaps.map((gap) => `${rangeLabel(gap.from, gap.to)}${gap.reason ? `（${gap.reason}）` : ""}`).join("、")}
                  </p>
                )}
                {stage.error && <p className="mt-0.5 text-[11px] text-red-400">{stage.error}</p>}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-text-muted">
            退出页面或关闭浏览器不会中断同步；换设备登录后进度保持不变。近期训练详情在“近期数据”就绪后即可查看，历史补齐失败不影响近期数据。
          </p>
        </div>
      )}
    </section>
  );
}
