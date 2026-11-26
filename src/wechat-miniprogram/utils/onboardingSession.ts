// 首次同步 session 视图的纯展示映射（devops#1015 / epic devops#1004 T11；文案与
// Web frontend/src/onboardingSync/sessionModel.ts 保持一致，两端对照排查能对上）。
// 视图来自 GET /users/me/onboarding/sync，由服务端推导——这里只做展示整形与
// 可见性判断，绝不推断超出服务端上报的就绪状态（completed_with_gaps 不是完整
// 覆盖，不能当完整展示）。自检见 utils/onboardingSession.check.mts。

import type { OnboardingSyncReadiness, OnboardingSyncStageGap, OnboardingSyncStageView, OnboardingSyncView } from '../services/onboarding-sync';

/** 状态卡轮询间隔（与 Web SESSION_POLL_MS 一致）。 */
export const SESSION_POLL_MS = 5000;

export function sessionStateLabel(state: string): string {
  switch (state) {
    case 'waiting_legacy':
      return '接管已有同步任务';
    case 'dispatching':
      return '正在启动同步';
    case 'running':
      return '同步进行中';
    case 'failed':
      return '同步失败';
    case 'completed_with_gaps':
      return '同步完成（部分缺项）';
    case 'completed':
      return '同步完成';
    case 'superseded':
      return '已由新绑定取代';
    default:
      return state;
  }
}

/** 终态 = session 链不会再自行推进。failed / completed_with_gaps 仍展示（错误 + 重试、缺项）；completed / superseded 隐藏。 */
export function isSessionTerminal(state: string): boolean {
  return (
    state === 'completed' || state === 'completed_with_gaps' || state === 'failed' || state === 'superseded'
  );
}

export function shouldHideStatusCard(view: OnboardingSyncView | null, dismissed: boolean): boolean {
  if (!view || dismissed) return true;
  return view.state === 'completed' || view.state === 'superseded';
}

export function historicalAnalysisLabel(view: OnboardingSyncView): string {
  if (view.historical_analysis_reason) return '待人工处理';
  return view.readiness.historical_analysis === 'pending' ? '待处理' : readinessLabel(view.readiness.historical_analysis);
}

export function readinessLabel(level: OnboardingSyncReadiness): string {
  switch (level) {
    case 'ready':
      return '已就绪';
    case 'ready_with_gaps':
      return '已就绪（有缺项）';
    case 'running':
      return '进行中';
    case 'pending':
      return '等待中';
    case 'failed':
      return '失败';
    case 'partial':
      return '部分可用';
    case 'unavailable':
      return '暂不可用';
    default:
      return '未开始';
  }
}

export type ReadinessTone = 'good' | 'warn' | 'bad' | 'muted';

export function readinessTone(level: OnboardingSyncReadiness): ReadinessTone {
  switch (level) {
    case 'ready':
      return 'good';
    case 'ready_with_gaps':
    case 'partial':
      return 'warn';
    case 'failed':
      return 'bad';
    default:
      return 'muted';
  }
}

// 摘要 chips（spec：原始/派生/辅助分开，历史失败不收回近期）。shell_ready 是 bool，刻意不做 chip。
export type ReadinessKey = Exclude<keyof OnboardingSyncView['readiness'], 'shell_ready'>;

export const READINESS_SUMMARY: Array<{ key: ReadinessKey; label: string }> = [
  { key: 'recent_data', label: '近期数据' },
  { key: 'recent_analysis', label: '近期分析' },
  { key: 'extended_data', label: '历史扩展' },
  { key: 'historical_data', label: '历史补齐' },
  { key: 'historical_analysis', label: '历史分析' },
  { key: 'auxiliary', label: '辅助任务' },
];

const STAGE_LABELS: Record<string, string> = {
  recent_raw: '近期数据（活动 / 健康）',
  recent_analysis: '近期分析',
  extended_raw: '历史扩展（180日活动 / 90日健康）',
  historical_raw: '历史补齐（全部可访问活动）',
  auxiliary: '辅助任务（比赛识别 / 路线形状）',
};

export function stageLabel(stage: OnboardingSyncStageView): string {
  return STAGE_LABELS[stage.stage] ?? stage.stage;
}

/** "2026-11-10 ~ 2026-11-16"；缺界渲染为开口端，未完成的扫描不会读成完整覆盖。 */
export function rangeLabel(from?: string | null, to?: string | null): string {
  if (!from && !to) return '—';
  return `${from ?? '…'} ~ ${to ?? '…'}`;
}

// —— WXML 视图模型（WXML 不能调函数，行数据必须预整形）——

export interface SyncChipRow {
  key: ReadinessKey;
  /** 「近期数据」 */
  label: string;
  /** 「已就绪」等就绪度文案 */
  text: string;
  tone: ReadinessTone;
}

export interface SyncStageRow {
  key: string;
  label: string;
  readinessText: string;
  readinessTone: ReadinessTone;
  /** 「目标范围 2026-08-19 ~ 2026-11-16」 */
  targetText: string;
  /** 「实际覆盖 2026-09-01 ~ 2026-11-16」；无观察值时为空串（整行不渲染） */
  observedText: string;
  /** 「缺项：…（原因）、…」——合法缺测，与失败分开表达 */
  gapsText: string;
  /** 阶段错误（待抓取失败），非空才渲染 */
  error: string;
}

export interface SyncStatusViewModel {
  stateText: string;
  /** 卡片整体色调：failed → bad；completed_with_gaps → warn；其余 muted。 */
  tone: 'bad' | 'warn' | 'muted';
  failed: boolean;
  gapsTerminal: boolean;
  /** 近期数据就绪（ready / ready_with_gaps）时可给「查看近期活动」入口。 */
  recentReady: boolean;
  /** 顶层错误（session.error）；failed 无 error 时用固定文案兜底。 */
  errorText: string;
  chips: SyncChipRow[];
  stages: SyncStageRow[];
}

const NO_ERROR_FALLBACK = '部分同步任务失败，已完成的范围不会丢失。';

/** onboarding 同步步（session 模式）的标题 / 副标题 / 进度文案。WXML 不放嵌套三元，
 *  文案集中在这里便于自检与两端对照（Web 对应 SessionSubmitStep 的 phase 文案）。 */
export interface SessionStepTexts {
  title: string;
  subtitle: string;
  progressText: string;
  retryLabel: string;
}

export function sessionStepTexts(
  phase: 'creating' | 'adopting' | 'preparing',
  errorMode: 'create' | 'sync',
  hasError: boolean,
): SessionStepTexts {
  if (hasError) {
    if (errorMode === 'create') {
      return {
        title: '同步任务创建失败',
        subtitle: '后台没有正在运行的同步任务，不会重复导入数据',
        progressText: '',
        retryLabel: '重试创建',
      };
    }
    return {
      title: '同步失败',
      subtitle: '已完成的范围不会丢失；重试只恢复失败项，不重复导入',
      progressText: '',
      retryLabel: '重试失败项',
    };
  }
  if (phase === 'adopting') {
    return {
      title: '正在接管已有同步任务',
      subtitle: '正在接管已有的首次同步任务，进度不会丢失',
      progressText: '正在接管已有同步任务…',
      retryLabel: '',
    };
  }
  if (phase === 'preparing') {
    // 用户拍板 11-17：onboarding 内等近 90 天数据再进首页（实测 ~23s，文案按
    // 「预计 1 分钟」降预期；软超时 90s 放行）；历史/分析后台继续，首页无同步卡。
    return {
      title: '正在同步近 90 天训练数据',
      subtitle: '预计 1 分钟内完成；更早的历史数据会在后台继续补齐，不影响使用',
      progressText: '正在同步近 90 天训练数据…',
      retryLabel: '',
    };
  }
  return {
    title: '正在准备你的训练数据',
    subtitle: '先同步近 90 天数据，完成后进入首页；更早的历史在后台补齐',
    progressText: '正在创建首次同步任务…',
    retryLabel: '',
  };
}

/** preparing 进度文案：有前锋活动时显示具体名称（提交为新→旧，移动边是
 *  observed_from 那天；调用方取该日一条活动），否则回退到阶段描述。名称截断防溢出。 */
export function recentProgressText(
  activity?: { name: string | null; sport_name?: string | null; date: string } | null,
): string {
  const fallback = '正在同步近 90 天训练数据…';
  if (!activity || !activity.date) return fallback;
  const mmdd = activity.date.slice(5, 10);
  const rawLabel = activity.name || activity.sport_name || '';
  const label = rawLabel.length > 12 ? `${rawLabel.slice(0, 12)}…` : rawLabel;
  if (!label) return `${fallback.slice(0, -1)}（${mmdd}）`;
  return `正在同步：${mmdd} ${label}…`;
}

export function toSyncStatusViewModel(view: OnboardingSyncView): SyncStatusViewModel {
  const failed = view.state === 'failed';
  const gapsTerminal = view.state === 'completed_with_gaps';
  const recentReady =
    view.readiness.recent_data === 'ready' || view.readiness.recent_data === 'ready_with_gaps';

  const chips: SyncChipRow[] = READINESS_SUMMARY.map(({ key, label }) => {
    const level = view.readiness[key];
    if (expectedEmptyScan(summaryStage(view, key))) return { key, label, text: '已完成', tone: 'good' };
    return { key, label, text: readinessLabel(level), tone: readinessTone(level) };
  });

  const stages: SyncStageRow[] = view.stages.map((stage) => ({
    key: stage.stage,
    label: stageLabel(stage),
    readinessText: expectedEmptyScan(stage) ? '已完成' : readinessLabel(stage.readiness),
    readinessTone: expectedEmptyScan(stage) ? 'good' : readinessTone(stage.readiness),
    targetText: `目标范围 ${rangeLabel(stage.target_from, stage.target_to)}`,
    observedText:
      stage.observed_from || stage.observed_to
        ? `实际覆盖 ${rangeLabel(stage.observed_from, stage.observed_to)}`
        : '',
    gapsText: stage.gaps?.map(gapText).join('\n') || '',
    error: stage.error || '',
  }));

  return {
    stateText: sessionStateLabel(view.state),
    tone: failed ? 'bad' : gapsTerminal ? 'warn' : 'muted',
    failed,
    gapsTerminal,
    recentReady,
    errorText: failed || view.error ? view.error || NO_ERROR_FALLBACK : '',
    chips,
    stages,
  };
}

export function expectedEmptyScan(stage: OnboardingSyncStageView | undefined): boolean {
  return stage?.status === 'completed' && Boolean(stage.gaps?.length) && stage.gaps?.every((gap) => gap.kind === 'empty') === true;
}

const RAW_STAGES = {
  recent_data: 'recent_raw',
  extended_data: 'extended_raw',
  historical_data: 'historical_raw',
} as const;

export function summaryStage(view: OnboardingSyncView, key: ReadinessKey): OnboardingSyncStageView | undefined {
  if (key === 'historical_data') {
    return view.stages.find((stage) => stage.stage === 'historical_raw') ?? view.stages.find((stage) => stage.stage === 'extended_raw');
  }
  if (key === 'recent_data' || key === 'extended_data') {
    return view.stages.find((stage) => stage.stage === RAW_STAGES[key]);
  }
  return undefined;
}

export function gapText(gap: OnboardingSyncStageGap): string {
  const range = gap.from === gap.to ? gap.from : rangeLabel(gap.from, gap.to);
  const reason = gap.reason ? `（${gap.reason}）` : '';
  if (gap.kind === 'empty') {
    if (gap.health_history_days) return `手表只提供近 ${gap.health_history_days} 天健康数据 · ${range}`;
    const item = gap.channel === 'health' ? '健康记录' : gap.channel === 'dashboard' ? '手表摘要' : '训练记录';
    return `这段时间没有${item} · ${range}`;
  }
  if (gap.kind === 'transient') {
    const days = Math.round((Date.parse(gap.to) - Date.parse(gap.from)) / 86_400_000) + 1;
    return `${days > 0 && !gap.range_estimated ? `有 ${days} 天数据暂时拿不到` : '数据暂时拿不到'} · ${range}`;
  }
  if (gap.kind === 'unavailable') {
    const label = gap.reason?.startsWith('activity ') ? '有 1 条记录无法获取' : '这段时间的数据无法获取';
    return `${label} · ${range}${reason}`;
  }
  return `缺项：${rangeLabel(gap.from, gap.to)}${reason}`;
}
