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

import type { MasterPlanFormCard, Weekday } from '../services/master-plan';
import type { MasterPlanJobRequest } from '../services/plan-jobs';
import { shanghaiMonthDayLabel } from './coachCards';
import { PLAN_JOB_POLL_MS } from './planJobProgress';
import { WEEKDAY_VALUES } from './weekday';

// ── 表单 → kernel request ────────────────────────────────────────────────────

/**
 * 「更多选项」（#1030）：kernel request 里会**实际约束排课**的两项。表单卡
 * 本身不带这两项（服务端 MasterPlanFormCardSchema 没有），由表单「更多选项」
 * 折叠区预填并可改。默认值对齐现有代生成口径（不允许一天两练 / 力量
 * 2 次·周一+周四），不是无来源常量。
 */
export interface MasterPlanFormOptions {
  /** 是否允许一天两练。 */
  allows_double_sessions: boolean;
  /** 每周力量训练次数（0 = 不安排）。 */
  strength_sessions_per_week: number;
  /** 力量可用日（力量次数为 0 时为空）。 */
  strength_available_days: Weekday[];
}

/** 与 kernel 代生成既有口径一致的默认值（#1030 方案 B）。 */
export const DEFAULT_MASTER_PLAN_FORM_OPTIONS: MasterPlanFormOptions = {
  allows_double_sessions: false,
  strength_sessions_per_week: 2,
  strength_available_days: ['monday', 'thursday'],
};

export interface MasterPlanFormValues {
  form: MasterPlanFormCard;
  options: MasterPlanFormOptions;
}

const TRAINING_BASE_PREFIX = '近期训练基础：';
const RESTRICTION_PREFIX = '伤病或其他限制：';

/**
 * 表单卡 → MasterPlanGraphRequest（服务端 zod 严格复验，多余键会被拒）。
 * 表单提交即确认：user_confirmations 全真。目标成绩空 = 顺利完赛
 * （finish_only=true 且 target_time=null，二选一 XOR）。表单的自由文本
 * （训练基础 / 限制）进 preferences，不臆造结构化 injury 声明。
 * 「更多选项」两项必须由调用方传入（组件预填 + 用户可改），不在这里兜底。
 */
export function buildMasterPlanJobRequest(
  form: MasterPlanFormCard,
  requestId: string,
  options: MasterPlanFormOptions,
): MasterPlanJobRequest {
  const targetTime = form.goal.target_time.trim();
  const finishOnly = targetTime.length === 0;
  const trainingDays = form.availability.weekly_days;
  // 组件已拦空选；这里 fail-fast，绝不投递 weekly_run_days_max=1 却 7 天全不可用的请求。
  if (trainingDays.length === 0) throw new Error('weekly_days is empty');
  const strengthPerWeek = options.strength_sessions_per_week;
  if (!Number.isInteger(strengthPerWeek) || strengthPerWeek < 0) throw new Error('invalid strength_sessions_per_week');
  if (strengthPerWeek > 0 && options.strength_available_days.length === 0) {
    throw new Error('strength days required when strength sessions are scheduled');
  }
  const unavailableDays = WEEKDAY_VALUES.filter((day) => !trainingDays.includes(day));
  const preferences: string[] = [];
  const base = form.base.trim();
  const restriction = form.restriction.trim();
  if (base) preferences.push(`${TRAINING_BASE_PREFIX}${base}`);
  if (restriction) preferences.push(`${RESTRICTION_PREFIX}${restriction}`);
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
      allows_double_sessions: options.allows_double_sessions,
      preferred_long_run_day: form.availability.preferred_long_run_day,
      strength_sessions_per_week: strengthPerWeek,
      strength_available_days: strengthPerWeek > 0 ? [...options.strength_available_days] : [],
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

/** 「修改目标」从上次投递的请求回填，包括用户手动修改过的更多选项。 */
export function planJobFormValues(request: MasterPlanJobRequest): MasterPlanFormValues | null {
  const goal = request.goals?.[0];
  const availability = request.availability;
  if (!goal || !availability || !Array.isArray(availability.unavailable_days)) return null;
  const preference = (prefix: string): string =>
    request.preferences?.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? '';
  const defaults = DEFAULT_MASTER_PLAN_FORM_OPTIONS;
  return {
    form: {
      goal: {
        race_name: goal.race_name,
        distance: goal.distance,
        race_date: goal.race_date,
        target_time: goal.target_time ?? '',
      },
      availability: {
        weekly_days: WEEKDAY_VALUES.filter((day) => !availability.unavailable_days.includes(day)),
        preferred_long_run_day: WEEKDAY_VALUES.find((day) => day === availability.preferred_long_run_day) ?? null,
      },
      base: preference(TRAINING_BASE_PREFIX),
      restriction: preference(RESTRICTION_PREFIX),
    },
    options: {
      allows_double_sessions: availability.allows_double_sessions ?? defaults.allows_double_sessions,
      strength_sessions_per_week: availability.strength_sessions_per_week ?? defaults.strength_sessions_per_week,
      strength_available_days: WEEKDAY_VALUES.filter((day) =>
        (availability.strength_available_days ?? defaults.strength_available_days).includes(day),
      ),
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

// ── 轮询恢复语义（#1029）────────────────────────────────────────────────────

/** 连续网络失败到该值只**暂停**轮询（提示恢复入口），绝不本地判 failed。 */
export const MAX_PLAN_JOB_POLL_FAILURES = 6;

/** 轮询失败后的动作：仍可退避重试 / 暂停等用户或 onShow 恢复。 */
export function planJobPollFailureAction(failures: number): 'backoff' | 'pause' {
  return failures >= MAX_PLAN_JOB_POLL_FAILURES ? 'pause' : 'backoff';
}

/** 指数退避：2.5 → 5 → 10 → 20 → 30s 封顶。 */
export function planJobPollBackoffMs(failures: number, baseMs: number = PLAN_JOB_POLL_MS): number {
  return Math.min(baseMs * 2 ** Math.max(0, Math.min(failures - 1, 4)), 30_000);
}

/** 重试前探到的服务端真实状态（gone = 404 无此单）。 */
export type PlanJobProbeOutcome = 'queued' | 'running' | 'done' | 'failed' | 'gone';

export type PlanJobRetryAction = 'resume' | 'show-result' | 'repost';

/** 两步重试决策：还在跑 → 继续原单；完成 → 出结果卡；确实失败/无单 → 重投。 */
export function decideRetryAction(outcome: PlanJobProbeOutcome): PlanJobRetryAction {
  if (outcome === 'queued' || outcome === 'running') return 'resume';
  if (outcome === 'done') return 'show-result';
  return 'repost';
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
  /** 旧版本保存过的表单消息 id。历史重载后不能直接按此 id 匹配。 */
  formMessageId?: number;
  /** 表单消息在服务端历史投影里的行序（CoachMessage.shareIndex，与分享 indices 同源）。
   *  历史重载后 id 会重排，这个序号不会——跨进程识别「已提交表单」靠它。 */
  formShareIndex?: number;
  /** 历史不可用期间提交时保留源卡的预填目标，供历史恢复后识别唯一匹配。 */
  formSourceGoal?: MasterPlanFormCard['goal'];
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
  /** 网络持续失败、轮询暂时停下（卡上显示恢复入口；#1029）。 */
  pollPaused?: boolean;
  /** 进度卡标题（带计划名，#1024 用户拍板：提交信息并进进度卡）。 */
  planTitle?: string;
  /** 提交信息摘要行（项目/日期/目标/每周天数）。 */
  requestSummary?: string;
}

const JOB_KEY_PREFIX = 'plan-job:';
const JOB_INDEX_KEY = 'plan-job:index';
/** 本地最多保留的 job 卡数量（超出按创建时间淘汰最旧，防 storage 无限长）。 */
const MAX_STORED_JOBS = 20;

/** 本页内存副本：storage 写失败（配额/隐私模式）时进度卡仍能工作。 */
const memoryJobs = new Map<string, PlanJobRecord>();

/** 读卡：本进程的最新更新优先，storage 提供上次运行保存的记录。 */
export function readPlanJobCached(jobId: string): PlanJobRecord | null {
  return memoryJobs.get(jobId) ?? readPlanJob(jobId);
}

/** 更新卡：写内存副本 + best-effort 落 storage（storage 失败不阻断本页进度）。 */
export function updatePlanJobRecord(jobId: string, patch: Partial<PlanJobRecord>): PlanJobRecord | null {
  const current = readPlanJobCached(jobId);
  if (!current) return null;
  const next: PlanJobRecord = { ...current, ...patch, jobId: current.jobId };
  savePlanJob(next);
  return next;
}

/** 本地记录 → 卡片视图（applied/paused 由页面侧状态注入；纯函数）。 */
export function planJobCardView(record: PlanJobRecord, applied: boolean, pollPaused = false): PlanJobCardView {
  return {
    jobId: record.jobId,
    status: record.status,
    stage: record.stage,
    progressPct: record.progressPct,
    createdAt: record.createdAt,
    title: record.resultTitle,
    subtitle: record.resultSubtitle,
    applied,
    pollPaused,
    /** 进度卡标题/摘要带提交信息（#1024 用户拍板：提交信息并进进度卡）。 */
    planTitle: planJobGenerateTitle(record.request),
    requestSummary: planJobRequestSummary(record.request),
  };
}

/** 进度卡标题：无锡马拉松250的备赛计划 / 无锡马拉松的备赛计划（完赛）。 */
export function planJobGenerateTitle(request: MasterPlanJobRequest): string {
  const goal = request.goals[0];
  const race = goal?.race_name?.trim() || '赛季训练';
  const target = goal?.target_time || '';
  const breakthrough = target ? breakthroughNumber(target) : '';
  return breakthrough
    ? `正在为你生成${race}${breakthrough}的备赛计划`
    : `正在为你生成${race}的备赛计划`;
}

/** 提交信息摘要行：全程 · 2027-03-07 · 目标 2:50:00 · 每周 5 天。 */
export function planJobRequestSummary(request: MasterPlanJobRequest): string {
  const goal = request.goals[0];
  const distance = goal?.distance === 'HM' ? '半马' : '全马';
  const target = goal?.target_time ? ` · 目标 ${goal.target_time}` : ' · 顺利完赛';
  const days = request.availability.weekly_run_days_max;
  return `${distance} · ${goal?.race_date ?? ''}${target} · 每周 ${days} 天`;
}

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

function writeIndex(ids: string[]): boolean {
  try {
    wx.setStorageSync(JOB_INDEX_KEY, ids);
    return true;
  } catch {
    return false;
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
  for (const id of new Set([...readIndex(), ...memoryJobs.keys()])) {
    const job = readPlanJobCached(id);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_STORED_JOBS);
}

/** 写卡（同步）；storage 不可用时返回 false，由调用方提示「进度可能无法恢复」。 */
export function savePlanJob(job: PlanJobRecord): boolean {
  memoryJobs.delete(job.jobId);
  memoryJobs.set(job.jobId, job);
  if (memoryJobs.size > MAX_STORED_JOBS) {
    const oldest = memoryJobs.keys().next().value;
    if (oldest !== undefined) memoryJobs.delete(oldest);
  }
  try {
    wx.setStorageSync(JOB_KEY_PREFIX + job.jobId, job);
  } catch {
    return false;
  }
  const ids = [job.jobId, ...readIndex().filter((id) => id !== job.jobId)];
  const kept = ids.slice(0, MAX_STORED_JOBS);
  for (const dropped of ids.slice(MAX_STORED_JOBS)) {
    memoryJobs.delete(dropped);
    try {
      wx.removeStorageSync(JOB_KEY_PREFIX + dropped);
    } catch {
      /* ignore */
    }
  }
  return writeIndex(kept);
}

/** 删除一张卡（重试换新 job id / 淘汰旧卡时用）。 */
export function removePlanJob(jobId: string): void {
  memoryJobs.delete(jobId);
  try {
    wx.removeStorageSync(JOB_KEY_PREFIX + jobId);
  } catch {
    /* ignore */
  }
  writeIndex(readIndex().filter((id) => id !== jobId));
}
