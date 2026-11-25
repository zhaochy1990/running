/**
 * onboardingSession.ts 自检：`node utils/onboardingSession.check.mts`（或 `npm test`）。
 * 只覆盖纯展示映射与可见性判断，不依赖小程序运行时。
 */
import {
  READINESS_SUMMARY,
  historicalAnalysisLabel,
  isSessionTerminal,
  rangeLabel,
  readinessLabel,
  readinessTone,
  recentProgressText,
  sessionStateLabel,
  sessionStepTexts,
  shouldHideStatusCard,
  toSyncStatusViewModel,
} from './onboardingSession.ts';
import type { OnboardingSyncView } from '../services/onboarding-sync.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// —— 状态文案：与 Web sessionModel.ts 一一对应（两端契约）——
eq(sessionStateLabel('waiting_legacy'), '接管已有同步任务', 'waiting_legacy label');
eq(sessionStateLabel('dispatching'), '正在启动同步', 'dispatching label');
eq(sessionStateLabel('running'), '同步进行中', 'running label');
eq(sessionStateLabel('failed'), '同步失败', 'failed label');
eq(sessionStateLabel('completed_with_gaps'), '同步完成（部分缺项）', 'completed_with_gaps label');
eq(sessionStateLabel('completed'), '同步完成', 'completed label');
eq(sessionStateLabel('superseded'), '已由新绑定取代', 'superseded label');
eq(sessionStateLabel('weird_future_state'), 'weird_future_state', 'unknown state falls back to raw');

// —— 终态：链路不再自行推进 ——
for (const s of ['completed', 'completed_with_gaps', 'failed', 'superseded']) {
  eq(isSessionTerminal(s), true, `${s} is terminal`);
}
for (const s of ['waiting_legacy', 'dispatching', 'running']) {
  eq(isSessionTerminal(s), false, `${s} is not terminal`);
}

// —— 可见性：无视图 / 已忽略 / completed / superseded 隐藏；failed 与带缺项终态保留 ——
eq(shouldHideStatusCard(null, false), true, 'no view hides');
eq(shouldHideStatusCard({ state: 'running' } as OnboardingSyncView, true), true, 'dismissed hides');
eq(shouldHideStatusCard({ state: 'completed' } as OnboardingSyncView, false), true, 'completed hides');
eq(shouldHideStatusCard({ state: 'superseded' } as OnboardingSyncView, false), true, 'superseded hides');
eq(shouldHideStatusCard({ state: 'failed' } as OnboardingSyncView, false), false, 'failed stays');
eq(shouldHideStatusCard({ state: 'completed_with_gaps' } as OnboardingSyncView, false), false, 'gaps stays');
eq(shouldHideStatusCard({ state: 'running' } as OnboardingSyncView, false), false, 'running stays');

// —— 就绪度：文案与色调；合法缺测（warn）不能与失败（bad）混同 ——
eq(readinessLabel('ready'), '已就绪', 'ready label');
eq(readinessLabel('ready_with_gaps'), '已就绪（有缺项）', 'ready_with_gaps label');
eq(readinessLabel('unavailable'), '暂不可用', 'unavailable label');
eq(readinessLabel('not_started'), '未开始', 'not_started default');
eq(readinessTone('ready'), 'good', 'ready tone');
eq(readinessTone('ready_with_gaps'), 'warn', 'gap tone is warn not bad');
eq(readinessTone('partial'), 'warn', 'partial tone');
eq(readinessTone('failed'), 'bad', 'failed tone');
eq(readinessTone('running'), 'muted', 'running tone');
eq(readinessTone('pending'), 'muted', 'pending tone');

// —— 范围：开口端表达「未扫完」，不伪装完整覆盖 ——
eq(rangeLabel('2026-11-10', '2026-11-16'), '2026-11-10 ~ 2026-11-16', 'full range');
eq(rangeLabel(null, '2026-11-16'), '… ~ 2026-11-16', 'open from');
eq(rangeLabel('2026-08-19', null), '2026-08-19 ~ …', 'open to');
eq(rangeLabel(null, null), '—', 'no bounds');

// —— 摘要 chips：五项固定，顺序即展示顺序，shell_ready 不在其中 ——
eq(READINESS_SUMMARY.map((c) => c.key), ['recent_data', 'recent_analysis', 'extended_data', 'historical_data', 'historical_analysis', 'auxiliary'], 'chip keys');
eq(READINESS_SUMMARY.map((c) => c.label), ['近期数据', '近期分析', '历史扩展', '历史补齐', '历史分析', '辅助任务'], 'chip labels');

// —— 视图模型整形 ——
const view: OnboardingSyncView = {
  session_id: 's1',
  state: 'failed',
  shell_ready: true,
  provider: 'garmin',
  binding_revision: 3,
  anchor_day: '2026-11-17',
  retry_count: 1,
  error: 'garmin 5xx',
  stages: [
    {
      stage: 'recent_raw',
      status: 'completed_with_gaps',
      readiness: 'ready_with_gaps',
      target_from: '2026-08-19',
      target_to: '2026-11-17',
      observed_from: '2026-09-01',
      observed_to: '2026-11-17',
      gaps: [{ from: '2026-08-19', to: '2026-08-31', reason: 'provider_unavailable' }],
    },
    {
      stage: 'historical_raw',
      status: 'failed',
      readiness: 'failed',
      target_from: '2019-01-01',
      target_to: '2026-08-19',
      error: 'auth expired',
    },
  ],
  readiness: {
    shell_ready: true,
    recent_data: 'ready_with_gaps',
    recent_analysis: 'ready',
    extended_data: 'running',
    historical_data: 'failed',
    historical_analysis: 'not_started',
    auxiliary: 'pending',
  },
  created_at: '2026-11-17T00:00:00Z',
  updated_at: '2026-11-17T00:10:00Z',
};

const vm = toSyncStatusViewModel(view);
eq(vm.stateText, '同步失败', 'vm state text');
eq(vm.tone, 'bad', 'vm failed tone');
eq(vm.failed, true, 'vm failed flag');
eq(vm.recentReady, true, 'recent ready_with_gaps counts as ready');
eq(vm.errorText, 'garmin 5xx', 'vm top error');
eq(vm.chips.length, 6, 'vm six chips');
eq(vm.chips[0], { key: 'recent_data', label: '近期数据', text: '已就绪（有缺项）', tone: 'warn' }, 'vm chip 0');
eq(vm.chips[3], { key: 'historical_data', label: '历史补齐', text: '失败', tone: 'bad' }, 'vm chip 3');
eq(vm.stages.length, 2, 'vm two stage rows');
eq(vm.stages[0].label, '近期数据（活动 / 健康）', 'vm stage label');
eq(vm.stages[0].targetText, '目标范围 2026-08-19 ~ 2026-11-17', 'vm target text');
eq(vm.stages[0].observedText, '实际覆盖 2026-09-01 ~ 2026-11-17', 'vm observed text');
eq(vm.stages[0].gapsText, '缺项：2026-08-19 ~ 2026-08-31（provider_unavailable）', 'vm gaps text');
eq(vm.stages[0].error, '', 'vm no stage error');
eq(vm.stages[1].readinessText, '失败', 'vm failed stage readiness');
eq(vm.stages[1].observedText, '', 'vm no observation → empty string');
eq(vm.stages[1].gapsText, '', 'vm no gaps → empty string');
eq(vm.stages[1].error, 'auth expired', 'vm stage error kept');

// failed 但服务端没给 error：用固定兜底文案，不许空白。
const noErrorView = { ...view, error: null } as OnboardingSyncView;
eq(toSyncStatusViewModel(noErrorView).errorText, '部分同步任务失败，已完成的范围不会丢失。', 'failed without error falls back');

// completed_with_gaps：整体 warn，不是 bad；错误行只在 failed 或有顶层 error 时出现。
const gapsView = { ...view, state: 'completed_with_gaps', error: null } as OnboardingSyncView;
const gapsVm = toSyncStatusViewModel(gapsView);
eq(gapsVm.tone, 'warn', 'gaps terminal tone');
eq(gapsVm.failed, false, 'gaps terminal not failed');
eq(gapsVm.errorText, '', 'gaps terminal without error → no error line');

// running：muted，无错误行。
const runningVm = toSyncStatusViewModel({ ...view, state: 'running', error: null } as OnboardingSyncView);
eq(runningVm.tone, 'muted', 'running tone');
eq(runningVm.errorText, '', 'running no error');

// 未知阶段名：回落原名，不编造文案。
const unknownStage = { ...view, stages: [{ ...view.stages[0], stage: 'future_stage' }] } as OnboardingSyncView;
eq(toSyncStatusViewModel(unknownStage).stages[0].label, 'future_stage', 'unknown stage falls back to raw name');

// —— 提交步文案：创建失败不许假报后台在跑；接管与链路失败各有准确说法 ——
eq(
  sessionStepTexts('creating', 'create', false).title,
  '正在准备你的训练数据',
  'creating title',
);
eq(
  sessionStepTexts('creating', 'create', false).subtitle.includes('完成后进入首页'),
  true,
  'creating subtitle promises home entry after recent data is ready',
);
eq(
  sessionStepTexts('adopting', 'create', false).title,
  '正在接管已有同步任务',
  'adopting title',
);
// preparing（用户拍板 11-17）：onboarding 内等近 90 天数据，历史明确说后台补。
const preparing = sessionStepTexts('preparing', 'sync', false);
eq(preparing.title, '正在同步近 90 天训练数据', 'preparing title');
eq(
  preparing.subtitle.includes('预计 1 分钟'),
  true,
  'preparing subtitle under-promises (~23s actual, copy says 1 minute)',
);
eq(
  preparing.subtitle.includes('后台继续补齐'),
  true,
  'preparing subtitle says history continues in background',
);
eq(
  preparing.progressText.includes('90 天'),
  true,
  'preparing progress names the 90-day scope',
);
eq(preparing.retryLabel, '', 'preparing has no retry label while working');
eq(
  sessionStepTexts('preparing', 'sync', true).retryLabel,
  '重试失败项',
  'preparing failure keeps single-item retry label',
);
// 前锋活动文案：有名显示「正在同步：MM-DD 名称…」，无名回退日期，全空回退阶段描述。
eq(recentProgressText(null), '正在同步近 90 天训练数据…', 'frontier text falls back without activity');
eq(
  recentProgressText({ name: '上海苗江路轻松跑', sport_name: null, date: '2026-11-16 08:30:00' }),
  '正在同步：11-16 上海苗江路轻松跑…',
  'frontier text names the activity with MM-DD',
);
eq(
  recentProgressText({ name: null, sport_name: '跑步', date: '2026-11-16' }),
  '正在同步：11-16 跑步…',
  'frontier text falls back to sport_name',
);
eq(
  recentProgressText({ name: null, sport_name: null, date: '2026-11-16' }),
  '正在同步近 90 天训练数据（11-16）',
  'frontier text keeps the date when no name exists',
);
eq(
  recentProgressText({ name: '一二三四五六七八九十甲乙丙丁戊', sport_name: null, date: '2026-11-16' }).includes('…'),
  true,
  'frontier text truncates long names',
);
const createFailed = sessionStepTexts('creating', 'create', true);
eq(createFailed.title, '同步任务创建失败', 'create-failed title');
eq(createFailed.subtitle, '后台没有正在运行的同步任务，不会重复导入数据', 'create-failed must not claim background sync');
eq(createFailed.retryLabel, '重试创建', 'create-failed retry label');
eq(createFailed.progressText, '', 'create-failed hides progress card');
const syncFailed = sessionStepTexts('adopting', 'sync', true);
eq(syncFailed.title, '同步失败', 'sync-failed title');
eq(syncFailed.subtitle, '已完成的范围不会丢失；重试只恢复失败项，不重复导入', 'sync-failed keeps completed ranges');
eq(syncFailed.retryLabel, '重试失败项', 'sync-failed retry label');
eq(sessionStepTexts('creating', 'create', false).retryLabel, '', 'no retry label while working');

console.log('onboardingSession.check: OK');

eq(historicalAnalysisLabel({ readiness: { historical_analysis: 'ready_with_gaps' } } as OnboardingSyncView),
  '已就绪（有缺项）', 'published historical result preserves gaps');
eq(historicalAnalysisLabel({ historical_analysis_reason: 'interruption_limit', readiness: { historical_analysis: 'pending' } } as OnboardingSyncView),
  '待人工处理', 'paused historical work');
