/**
 * 首次同步覆盖推导（devops#1013，epic devops#1004 T09）。
 *
 * Coach 只读消费 Go-owned onboarding sync session 的四张表（sessions /
 * stage_coverage / dispatches / recent_analysis），在 TS 侧按 Go
 * `onboardingsync.View` 的同一套语义推导就绪级别（stageReadiness /
 * analysisReadiness 的逐条镜像），并生成给教练模型看的可解释说明：
 * 原始/分析覆盖、as-of、revision、gaps、pending/partial/unavailable，
 * 以及「历史指标需显式重算（pending_explicit_recompute），未交付前不得
 * 宣告长期分析完整」的硬结论。
 *
 * 本模块是纯函数：MySQL 行进来（snake_case，mysql2 原样），SyncCoverage
 * 出去；不含 IO，便于与 Go 侧共享 fixture 做跨语言一致性验证。
 */

import type { SyncCoverage, SyncReadiness, SyncStageCoverage, SyncStageGap } from "./dataProvider.js";

/** onboarding_sync_sessions 一行（coach 读到的 snake_case 投影）。 */
export interface SyncSessionRow {
  session_id: string;
  provider: string;
  binding_revision: number;
  anchor_day: string;
  state: string;
  shell_ready: number | boolean;
  last_error: string | null;
  updated_at: Date | string;
  historical_analysis_reason?: string | null;
}

/** onboarding_sync_stage_coverage 一行。 */
export interface SyncStageCoverageRow {
  stage: string;
  status: string;
  target_from: string;
  target_to: string;
  scanned_from: string | null;
  scanned_to: string | null;
  observed_from: string | null;
  observed_to: string | null;
  gaps_json: string | null;
  last_error: string | null;
}

/** onboarding_sync_dispatches 一行（只看 stage + status）。 */
export interface SyncDispatchRow {
  stage: string;
  status: string;
}

/** onboarding_recent_analysis 一行。 */
export interface SyncRecentAnalysisRow {
  as_of_day: string;
  status: string;
  stale: number | boolean;
  domains_json: string | null;
  coverage_from: string | null;
  coverage_to: string | null;
  input_fingerprint: string;
  computed_at: Date | string;
}

const truthy = (v: number | boolean | null | undefined): boolean => v === 1 || v === true;

function parseGaps(raw: string | null): SyncStageGap[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is SyncStageGap => typeof g === "object" && g !== null && typeof (g as SyncStageGap).from === "string");
  } catch {
    return [];
  }
}

function parseDomains(raw: string | null): Record<string, { status: string; reason?: string }> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, { status: string; reason?: string }> = {};
    for (const [domain, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as { status?: unknown; reason?: unknown };
      if (typeof entry.status !== "string") continue;
      out[domain] = typeof entry.reason === "string" ? { status: entry.status, reason: entry.reason } : { status: entry.status };
    }
    return out;
  } catch {
    return {};
  }
}

/** stageReadiness 的 Go 镜像：ready 要求扫描完成且观测窗真覆盖目标窗，gaps 显式降级。 */
export function stageReadiness(
  row: Pick<SyncStageCoverageRow, "status" | "observed_from" | "observed_to" | "target_from" | "target_to" | "gaps_json">,
): SyncReadiness {
  switch (row.status) {
    case "completed":
      if (row.observed_from == null || row.observed_to == null) return "running"; // 扫完但无观测：不算 ready
      if (row.observed_from > row.target_from || row.observed_to < row.target_to) return "running"; // 观测未覆盖目标
      if ((row.gaps_json ?? "").length > 0 && row.gaps_json !== "[]") return "ready_with_gaps";
      return "ready";
    case "completed_with_gaps":
      return "ready_with_gaps";
    case "failed":
      return "failed";
    case "running":
      return "running";
    default:
      return "pending"; // pending
  }
}

function analysisRowLevel(row: Pick<SyncRecentAnalysisRow, "status">): SyncReadiness {
  switch (row.status) {
    case "ready":
      return "ready";
    case "partial":
      return "partial";
    case "unavailable":
      return "unavailable";
    default:
      return "pending";
  }
}

/** analysisReadiness 的 Go 镜像：就绪级别显式来自已发布结果行，刷新中不收回已发布结论。 */
export function analysisReadiness(
  row: Pick<SyncStageCoverageRow, "status">,
  dispatchFailed: boolean,
  analysisRow: Pick<SyncRecentAnalysisRow, "status"> | null,
): SyncReadiness {
  if (dispatchFailed) return "failed";
  // 刷新进行中（coverage 回到 pending/running）不收回已发布结果：级别保持，详情带 stale/refreshing。
  if (analysisRow != null && (row.status === "pending" || row.status === "running")) {
    return analysisRowLevel(analysisRow);
  }
  switch (row.status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "completed":
    case "completed_with_gaps":
      if (analysisRow == null) return "pending"; // job 终态但发布行未落地：显式不算 ready
      return analysisRowLevel(analysisRow);
    default:
      return "pending";
  }
}

/**
 * 从四张表的原始行推导用户视角的覆盖快照——与 Go GET /api/users/me/
 * onboarding/sync 的 View 同语义（dispatch failed 覆盖 coverage status、
 * refreshing 派生、waiting_legacy 压 recent 为 pending）。
 */
export function deriveSyncCoverage(
  session: SyncSessionRow,
  coverageRows: SyncStageCoverageRow[],
  dispatchRows: SyncDispatchRow[],
  analysisRow: SyncRecentAnalysisRow | null,
  historical?: { readiness: SyncReadiness; recentEvidence?: { load: boolean; zones: boolean; ability: boolean } },
): SyncCoverage {
  const dispatchByStage = new Map(dispatchRows.map((d) => [d.stage, d]));
  const stages: SyncStageCoverage[] = [];
  const readiness = {
    shellReady: truthy(session.shell_ready),
    recentData: "pending" as SyncReadiness,
    recentAnalysis: "not_started" as SyncReadiness,
    extendedData: "not_started" as SyncReadiness,
    historicalData: "not_started" as SyncReadiness,
    historicalAnalysis: "not_started" as SyncReadiness,
    auxiliary: "not_started" as SyncReadiness,
  };
  let recentAnalysisDetail: SyncCoverage["recentAnalysisDetail"] = null;
  for (const cov of coverageRows) {
    const dispatch = dispatchByStage.get(cov.stage);
    const dispatchFailed = dispatch?.status === "failed";
    const refreshing = dispatch?.status === "dispatched";
    const stage: SyncStageCoverage = {
      stage: cov.stage,
      status: dispatchFailed ? "failed" : cov.status,
      readiness: "pending",
      targetFrom: cov.target_from,
      targetTo: cov.target_to,
      scannedFrom: cov.scanned_from,
      scannedTo: cov.scanned_to,
      observedFrom: cov.observed_from,
      observedTo: cov.observed_to,
      gaps: parseGaps(cov.gaps_json),
      error: cov.last_error,
    };
    switch (cov.stage) {
      case "recent_raw":
        stage.readiness = stageReadiness(cov);
        readiness.recentData = stage.readiness;
        break;
      case "recent_analysis": {
        stage.readiness = analysisReadiness(cov, dispatchFailed, analysisRow);
        readiness.recentAnalysis = stage.readiness;
        if (analysisRow != null) {
          recentAnalysisDetail = {
            asOfDay: analysisRow.as_of_day,
            status: analysisRow.status,
            stale: truthy(analysisRow.stale),
            refreshing: refreshing || cov.status === "running",
            domains: parseDomains(analysisRow.domains_json),
            coverageFrom: analysisRow.coverage_from,
            coverageTo: analysisRow.coverage_to,
            inputFingerprint: analysisRow.input_fingerprint,
            computedAt: new Date(analysisRow.computed_at),
          };
        }
        break;
      }
      case "extended_raw":
        stage.readiness = stageReadiness(cov);
        readiness.extendedData = stage.readiness;
        if (readiness.historicalData === "not_started") readiness.historicalData = stage.readiness;
        break;
      case "historical_raw":
        stage.readiness = stageReadiness(cov);
        readiness.historicalData = stage.readiness;
        break;
      case "auxiliary":
        stage.readiness = stageReadiness(cov);
        readiness.auxiliary = stage.readiness;
        break;
      default:
        stage.readiness = stageReadiness(cov);
    }
    stages.push(stage);
  }
  const terminal = (stage: string) => coverageRows.some((row) => row.stage === stage && (row.status === "completed" || row.status === "completed_with_gaps"));
  readiness.historicalAnalysis = historical?.readiness ?? (terminal("historical_raw") && terminal("auxiliary") ? "pending" : "not_started");
  if (historical?.recentEvidence && recentAnalysisDetail) {
    for (const domain of ["load", "zones", "ability"] as const) {
      if (recentAnalysisDetail.domains[domain]?.reason !== "historical_calibration_missing") continue;
      recentAnalysisDetail.domains[domain] = historical.recentEvidence[domain]
        ? { status: "ready" }
        : { status: "unavailable", reason: "no_published_evidence" };
    }
    const domains = Object.values(recentAnalysisDetail.domains);
    const ready = domains.filter((domain) => domain.status === "ready").length;
    recentAnalysisDetail.status = ready === domains.length ? "ready" : ready > 0 ? "partial" : "unavailable";
    if (readiness.recentAnalysis !== "failed" && readiness.recentAnalysis !== "not_started") {
      readiness.recentAnalysis = recentAnalysisDetail.status as SyncReadiness;
      const stage = stages.find((stage) => stage.stage === "recent_analysis");
      if (stage) stage.readiness = readiness.recentAnalysis;
    }
  }
  if (session.state === "waiting_legacy") readiness.recentData = "pending";
  return {
    sessionId: session.session_id,
    state: session.state,
    provider: session.provider,
    bindingRevision: Number(session.binding_revision),
    anchorDay: session.anchor_day,
    error: session.last_error,
    stages,
    readiness,
    ...(readiness.historicalAnalysis === "pending" && session.historical_analysis_reason
      ? { historicalAnalysisReason: session.historical_analysis_reason }
      : {}),
    recentAnalysisDetail,
    updatedAt: new Date(session.updated_at),
  };
}

/** 历史指标（多年 PMC / 历史 PB / 历史能力）的可解释状态。 */
export type HistoricalAnalysisStatus =
  | "pending_explicit_recompute"
  | "pending"
  | "running"
  | "partial"
  | "ready"
  | "ready_with_gaps"
  | "unavailable"
  | "failed";

/**
 * 教练视角的覆盖解释（devops#1013）：
 * - 近期结论只引用已获得的证据窗口；
 * - 长期结论明确受限：历史补齐未完成、或历史指标还待显式重算（T07/T08 未交付时
 *   固定 pending_explicit_recompute）时，longTermComplete=false——活动可读不等于
 *   长期趋势/PB 完整；
 * - 后台失败必须给出具体原因与出路，不能无限描述为「整理中」。
 */
export interface SyncCoverageExplanation {
  /** 近期已获得证据窗口（recent_raw 观测窗）；null = 尚无观测数据。 */
  recentEvidenceFrom: string | null;
  recentEvidenceTo: string | null;
  recentDataReadiness: SyncReadiness;
  recentAnalysis: {
    asOfDay: string | null;
    status: string | null;
    /** as-of 早于今天 = 跨日：结论基于旧数据，刷新中不收回。 */
    stale: boolean;
    refreshing: boolean;
    unavailableDomains: Array<{ domain: string; reason?: string }>;
    inputFingerprint: string | null;
  };
  historicalDataReadiness: SyncReadiness;
  historicalAnalysisStatus: HistoricalAnalysisStatus;
  /** 是否可以下长期结论（历史补齐 + 历史指标都已就绪）。 */
  longTermComplete: boolean;
  /** 面向运动员的中文说明（教练原样可引用）。 */
  notes: string[];
}

const STAGE_LABEL: Record<string, string> = {
  recent_raw: "近期数据（近 90 天活动 / 28 天健康）",
  recent_analysis: "近期分析（校准 / 负荷 / 心率区间 / 能力）",
  extended_raw: "扩展数据（近 180 天活动 / 90 天健康）",
  historical_raw: "全部历史活动",
  auxiliary: "辅助任务（比赛识别 / 路线形状）",
};

function gapNote(stage: SyncStageCoverage): string {
  const gaps = stage.gaps.map((g) => `${g.from}~${g.to}${g.reason ? `（${g.reason}）` : ""}`).join("、");
  return `${STAGE_LABEL[stage.stage] ?? stage.stage} 有 ${stage.gaps.length} 段永久缺口：${gaps}——这些区间厂商已确认不可获取，不会补齐，结论要避开。`;
}

/**
 * 生成覆盖解释。`today` 是上海自然日（YYYY-MM-DD），用于跨日 stale 判定。
 */
export function explainSyncCoverage(coverage: SyncCoverage, today: string): SyncCoverageExplanation {
  const byStage = new Map(coverage.stages.map((s) => [s.stage, s]));
  const recentRaw = byStage.get("recent_raw") ?? null;
  const detail = coverage.recentAnalysisDetail;
  const analysisStale = detail != null && detail.asOfDay < today;
  const unavailableDomains = detail
    ? Object.entries(detail.domains)
        .filter(([, v]) => v.status !== "ready")
        .map(([domain, v]) => (v.reason ? { domain, reason: v.reason } : { domain }))
    : [];

  const historicalAnalysisStatus: HistoricalAnalysisStatus =
    coverage.readiness.historicalAnalysis === "not_started" ? "pending_explicit_recompute" : coverage.readiness.historicalAnalysis;

  const longTermComplete = coverage.readiness.historicalData === "ready" && historicalAnalysisStatus === "ready";

  const notes: string[] = [];
  if (recentRaw?.observedFrom != null && recentRaw.observedTo != null) {
    notes.push(
      `已获得证据窗口：${recentRaw.observedFrom} ~ ${recentRaw.observedTo}（目标 ${recentRaw.targetFrom} ~ ${recentRaw.targetTo}）。近期问答只依据这个窗口内的数据。`,
    );
  } else {
    notes.push("近期数据还没有已确认的观测窗口，先不要对近期训练下结论，等同步出结果。");
  }
  for (const stage of coverage.stages) {
    if (stage.gaps.length > 0) notes.push(gapNote(stage));
  }
  if (detail != null) {
    const asOf = `近期分析基于 ${detail.asOfDay}（计算于 ${detail.computedAt.toISOString().slice(0, 10)}）`;
    if (detail.status === "unavailable") {
      notes.push(
        `${asOf}：近期分析不可用${unavailableDomains.length > 0 ? `（${unavailableDomains.map((d) => `${d.domain}${d.reason ? `：${d.reason}` : ""}`).join("；")}）` : ""}。这些指标缺证据就是不可用，不要用今天的数据顶替，也不要留空话。`,
      );
    } else if (detail.status === "partial" || unavailableDomains.length > 0) {
      notes.push(
        `${asOf}：近期分析部分可用——${Object.entries(detail.domains)
          .map(([k, v]) => `${k}=${v.status}`)
          .join("、")}。不可用的域明确说明，不要声称分析完整。`,
      );
    } else if (detail.status === "ready") {
      notes.push(`${asOf}：近期分析（校准/负荷/心率区间/能力）就绪。`);
    }
    if (analysisStale || detail.stale) {
      notes.push(
        `分析 as-of（${detail.asOfDay}）早于今天（${today}）${detail.stale ? "且输入已有更新" : ""}：跨日结论要注明基于该 as-of；${detail.refreshing ? "刷新正在进行，旧结论在刷新完成前仍然有效。" : "刷新尚未完成，不要把旧 as-of 的结论说成今天的状态。"}`,
      );
    }
  } else {
    notes.push("近期分析尚未发布：负荷/心率区间/能力等分析指标还没出结果，只能说「分析进行中」，不能编造数值。");
  }

  const historical = coverage.readiness.historicalData;
  if (historical === "running" || historical === "pending") {
    notes.push(
      "更早的历史还在后台补齐，尚未完成：长期训练趋势、历史 PB、多年负荷链都不完整，长期结论必须明确受限（例如「更早的历史仍在导入，当前长期结论只基于已导入区间」）。",
    );
  } else if (historical === "failed") {
    const err = coverage.stages.find((s) => s.stage === "historical_raw" || s.stage === "extended_raw")?.error;
    notes.push(`历史补齐失败${err ? `（原因：${err}）` : ""}：这不是「还在整理」，需要运动员在同步设置里重试或反馈问题；在此之前长期结论只能基于已导入区间。`);
  } else if (historical === "ready_with_gaps") {
    notes.push("历史活动已导入但存在永久缺口（见上方缺口说明），长期结论按已导入区间口径给出。");
  }
  if (historicalAnalysisStatus === "pending_explicit_recompute") {
    notes.push("历史指标（多年负荷链、历史 PB、历史能力）仍待历史补齐及重算：长期结论以已获得的证据为限。");
  }
  if (historicalAnalysisStatus === "pending") {
    const reason = coverage.historicalAnalysisReason;
    notes.push(
      reason === "interruption_limit"
        ? "历史重算多次被数据更新打断，等待人工处理。"
        : reason === "recompute_failed"
          ? "历史重算失败，等待人工处理。"
          : "历史分析待处理，长期结论以已获得的证据为限。",
    );
  } else if (historicalAnalysisStatus === "running") {
    notes.push("历史分析正在重算，长期结论以已发布的证据为限。");
  } else if (historicalAnalysisStatus === "ready" || historicalAnalysisStatus === "ready_with_gaps") {
    notes.push(
      historicalAnalysisStatus === "ready"
        ? "历史分析已发布（负荷/心率区间覆盖重算的 365 天窗口，PB 按已导入历史计算）。"
        : "历史分析已发布但有证据缺项（负荷/心率区间最多覆盖重算的 365 天窗口）。",
    );
  }
  if (coverage.state === "failed") {
    notes.push(`同步 session 已失败${coverage.error ? `（原因：${coverage.error}）` : ""}：如实说明失败，不要描述成整理中。`);
  }

  return {
    recentEvidenceFrom: recentRaw?.observedFrom ?? null,
    recentEvidenceTo: recentRaw?.observedTo ?? null,
    recentDataReadiness: coverage.readiness.recentData,
    recentAnalysis: {
      asOfDay: detail?.asOfDay ?? null,
      status: detail?.status ?? null,
      stale: analysisStale || (detail?.stale ?? false),
      refreshing: detail?.refreshing ?? false,
      unavailableDomains,
      inputFingerprint: detail?.inputFingerprint ?? null,
    },
    historicalDataReadiness: historical,
    historicalAnalysisStatus,
    longTermComplete,
    notes,
  };
}
