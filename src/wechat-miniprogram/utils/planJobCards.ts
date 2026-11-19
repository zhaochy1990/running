// 聊天侧赛季计划 job 卡（#1024 PR-2）的本地模型 —— 表单提交 → kernel
// request 组装、结果卡文案、本地卡持久化。
//
// 进度/结果卡不是服务端 checkpoint 消息：job 状态由 plan-jobs 轮询接口
// 提供（服务端为真源），本地只存「这张卡属于哪个会话 + 重试所需的最小
// 投递载荷」（apply_token/content 这类大载荷不落 storage，查看时按 job
// 现取 result_json）。key 口径：`plan-job:{jobId}`，另有一份 jobId 索引
// 供 onShow 扫描在途任务。
//
// 纯函数 + storage 薄封装（无网络依赖），配套 utils/planJobCards.check.mts。

import type { MasterPlanFormCard } from '../services/master-plan';
import type { MasterPlanJobRequest } from '../services/plan-jobs';
import { shanghaiMonthDayLabel } from './coachCards';
import { WEEKDAY_VALUES } from './weekday';

// ── 表单 → kernel request ────────────────────────────────────────────────────

/** 表单未收集单次训练时长，按 2 小时兜底（kernel 只要求正整数）。 */
const DEFAULT_MAX_SESSION_MIN = 120;

/**
 * 表单卡 → MasterPlanGraphRequest（服务端 zod 严格复验，多余键会被拒）。
 * 表单提交即确认：user_confirmations 全真。目标成绩空 = 顺利完赛
 * （finish_only=true 且 target_time=null，二选一 XOR）。表单的自由文本
 * （训练基础 / 限制）进 preferences，不臆造结构化 injury 声明。
 */
export function buildMasterPlanJobRequest(form: MasterPlanFormCard, requestId: string): MasterPlanJobRequest {
  const targetTime = form.goal.target_time.trim();
  const finishOnly = targetTime.length === 0;
  const trainingDays = form.availability.weekly_days;
  // 组件已拦空选；这里 fail-fast，绝不投递 weekly_run_days_max=1 却 7 天全不可用的请求。
  if (trainingDays.length === 0) throw new Error('weekly_days is empty');
  const unavailableDays = WEEKDAY_VALUES.filter((day) => !trainingDays.includes(day));
  const preferences: string[] = [];
  const base = form.base.trim();
  const restriction = form.restriction.trim();
  if (base) preferences.push(`近期训练基础：${base}`);
  if (restriction) preferences.push(`伤病或其他限制：${restriction}`);
  return {
    request_id: requestId,
    requested_mode: 'new_season',
    requested_modifiers: [],
    goals: [
      {
        race_name: form.goal.race_name.trim(),
        distance: form.goal.distance,
        race_date: form.goal.race_date,
        target_time: finishOnly ? null : targetTime,
        finish_only: finishOnly,
        priority: 'A',
      },
    ],
    availability: {
      weekly_run_days_max: trainingDays.length,
      available_training_windows: [],
      unavailable_days: [...unavailableDays],
      max_session_duration_min: DEFAULT_MAX_SESSION_MIN,
      allows_double_sessions: false,
      preferred_long_run_day: form.availability.preferred_long_run_day,
      strength_sessions_per_week: 0,
      strength_available_days: [],
    },
    injury_declarations: [],
    environment_constraints: [],
    travel_constraints: [],
    preferences,
    prohibited_arrangements: [],
    active_plan_action: 'none',
    user_confirmations: {
      intake_complete: true,
      goals_confirmed: true,
      availability_confirmed: true,
      injury_history_confirmed: true,
      constraints_confirmed: true,
    },
  };
}

// ── 结果卡文案 ──────────────────────────────────────────────────────────────

export interface PlanJobResultView {
  /** 结果卡标题（赛事 + 目标突破口径），如「无锡马拉松250突破计划」。 */
  title: string;
  /** 日期 / 周数 / 峰值一行摘要。 */
  subtitle: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 「2:50:00」→「250」（国内马拉松习惯的目标口径：小时×100+分）。 */
export function breakthroughNumber(targetTime: string): string {
  const [hour, minute] = targetTime.trim().split(':');
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
  return String(h * 100 + m);
}

/**
 * plan-jobs 轮询响应的 result_json → 候选 content。服务端（coach_agent_api
 * toPollResponse）按原始 JSON 字符串下发，这里兼容已解析对象；任何形状
 * 不对都返回 null（调用方走失败/重试文案，绝不拿半截数据去 apply）。
 */
export function planJobResultContent(resultJson: unknown): Record<string, unknown> | null {
  let parsed: unknown = resultJson;
  if (typeof resultJson === 'string') {
    if (resultJson.length === 0) return null;
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      return null;
    }
  }
  const doc = recordOf(parsed);
  return doc ? recordOf(doc.content) : null;
}

/**
 * job result_json.content（完整 v2 候选）→ 结果卡文案。字段缺失按
 * 计划内容自身降级（标题回落「赛季训练计划」），绝不臆造数字。
 */
export function planJobResultView(content: unknown): PlanJobResultView | null {
  const doc = recordOf(content);
  if (!doc) return null;
  const goal = recordOf(doc.goal) ?? {};
  const raceName = typeof goal.race_name === 'string' ? goal.race_name.trim() : '';
  const targetTime = typeof goal.target_time === 'string' ? goal.target_time.trim() : '';
  const raceDate = typeof goal.race_date === 'string' ? goal.race_date.trim() : '';
  const totalWeeks = typeof doc.total_weeks === 'number' && doc.total_weeks > 0 ? doc.total_weeks : null;
  const weeks = Array.isArray(doc.weeks) ? doc.weeks : [];
  let peakKm: number | null = null;
  for (const week of weeks) {
    const row = recordOf(week);
    const high = row?.target_weekly_km_high;
    if (typeof high === 'number' && Number.isFinite(high) && (peakKm === null || high > peakKm)) peakKm = high;
  }
  const breakthrough = targetTime ? breakthroughNumber(targetTime) : '';
  const title = raceName
    ? breakthrough
      ? `${raceName}${breakthrough}突破计划`
      : `${raceName}备赛计划`
    : '赛季训练计划';
  const parts: string[] = [];
  if (raceDate) parts.push(shanghaiMonthDayLabel(raceDate));
  if (totalWeeks !== null) parts.push(`${totalWeeks} 周`);
  if (peakKm !== null) parts.push(`峰值 ${Math.round(peakKm)} km`);
  return { title, subtitle: parts.join(' · ') };
}

// ── 本地卡持久化 ────────────────────────────────────────────────────────────

export type PlanJobStatus = 'running' | 'done' | 'failed';

/** 本地 job 卡记录（重试所需的最小投递载荷随卡保存）。 */
export interface PlanJobRecord {
  jobId: string;
  sessionId: string;
  /** job 首次投递（或重试重投）时间戳，进度动画的匀速轨道从此刻起算。 */
  createdAt: number;
  status: PlanJobStatus;
  /** 服务端阶段（reading_history / evaluating / …），未知时为空串。 */
  stage: string;
  progressPct: number;
  idempotencyKey: string;
  request: MasterPlanJobRequest;
  /** 提交这张表单的消息 id（本会话内稳定；重启后 id 会重排，仅作 best-effort 关联）。 */
  formMessageId?: number;
  /** done 时结果卡文案（轻量摘要；完整 content 不落 storage，查看时按 job 现取）。 */
  resultTitle?: string;
  resultSubtitle?: string;
}

/** 结果卡/失败卡的展示视图（页面对 storage 记录 + 结果内容派生后传给组件）。 */
export interface PlanJobCardView {
  jobId: string;
  status: PlanJobStatus;
  stage: string;
  progressPct: number;
  /** 匀速轨道起点（job 投递时间）。 */
  createdAt: number;
  /** done：结果卡标题/摘要（见 planJobResultView）。 */
  title?: string;
  subtitle?: string;
  /** done：候选计划已启用（预览页启用后回写）。 */
  applied?: boolean;
}

const JOB_KEY_PREFIX = 'plan-job:';
const JOB_INDEX_KEY = 'plan-job:index';
/** 本地最多保留的 job 卡数量（超出按创建时间淘汰最旧，防 storage 无限长）。 */
const MAX_STORED_JOBS = 20;

function isPlanJobRecord(value: unknown): value is PlanJobRecord {
  const v = recordOf(value);
  return (
    v != null &&
    typeof v.jobId === 'string' && v.jobId.length > 0 &&
    typeof v.sessionId === 'string' && v.sessionId.length > 0 &&
    typeof v.createdAt === 'number' &&
    (v.status === 'running' || v.status === 'done' || v.status === 'failed') &&
    typeof v.idempotencyKey === 'string' &&
    recordOf(v.request) != null
  );
}

function readIndex(): string[] {
  try {
    const raw = wx.getStorageSync(JOB_INDEX_KEY);
    if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    /* ignore */
  }
  return [];
}

function writeIndex(ids: string[]): void {
  try {
    wx.setStorageSync(JOB_INDEX_KEY, ids);
  } catch {
    /* ignore */
  }
}

export function readPlanJob(jobId: string): PlanJobRecord | null {
  try {
    const raw = wx.getStorageSync(JOB_KEY_PREFIX + jobId);
    return isPlanJobRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 所有本地 job 卡（按创建时间升序）。 */
export function listPlanJobs(): PlanJobRecord[] {
  const jobs: PlanJobRecord[] = [];
  for (const id of readIndex()) {
    const job = readPlanJob(id);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => a.createdAt - b.createdAt);
}

/** 写卡（同步）；storage 不可用时返回 false，由调用方提示「进度可能无法恢复」。 */
export function savePlanJob(job: PlanJobRecord): boolean {
  try {
    wx.setStorageSync(JOB_KEY_PREFIX + job.jobId, job);
  } catch {
    return false;
  }
  const ids = [job.jobId, ...readIndex().filter((id) => id !== job.jobId)];
  const kept = ids.slice(0, MAX_STORED_JOBS);
  for (const dropped of ids.slice(MAX_STORED_JOBS)) {
    try {
      wx.removeStorageSync(JOB_KEY_PREFIX + dropped);
    } catch {
      /* ignore */
    }
  }
  writeIndex(kept);
  return true;
}

/** 删除一张卡（重试换新 job id / 淘汰旧卡时用）。 */
export function removePlanJob(jobId: string): void {
  try {
    wx.removeStorageSync(JOB_KEY_PREFIX + jobId);
  } catch {
    /* ignore */
  }
  writeIndex(readIndex().filter((id) => id !== jobId));
}
