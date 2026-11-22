/**
 * planJobCards.ts 自检（#1024 PR-2 表单 → kernel request / 结果卡文案）：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/planJobCards.check.mts`。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { MasterPlanFormCard } from '../services/master-plan.ts';
import * as coachCards from './coachCards.ts';
import * as date from './date.ts';
import * as planJobCards from './planJobCards.ts';
import { WEEKDAY_VALUES } from './weekday.ts';
import {
  breakthroughNumber,
  buildMasterPlanJobRequest,
  decideRetryAction,
  DEFAULT_MASTER_PLAN_FORM_OPTIONS,
  MAX_PLAN_JOB_POLL_FAILURES,
  planJobPollBackoffMs,
  planJobPollFailureAction,
  planJobFormValues,
  planJobResultContent,
  planJobResultView,
} from './planJobCards.ts';

const form: MasterPlanFormCard = {
  goal: { race_name: ' 无锡马拉松 ', distance: 'FM', race_date: '2027-03-22', target_time: '2:50:00' },
  availability: { weekly_days: ['tuesday', 'thursday', 'saturday', 'sunday'], preferred_long_run_day: 'sunday' },
  base: '每周约 55 公里',
  restriction: '膝盖偶尔不适',
};

// 表单 → kernel request：目标成绩/完赛 XOR、训练日补集、自由文本进 preferences
{
  const request = buildMasterPlanJobRequest(form, 'req-1', DEFAULT_MASTER_PLAN_FORM_OPTIONS);
  assert.equal(request.request_id, 'req-1');
  assert.equal(request.requested_mode, 'new_season');
  assert.equal(request.goals.length, 1);
  assert.equal(request.goals[0].race_name, '无锡马拉松');
  assert.equal(request.goals[0].distance, 'FM');
  assert.equal(request.goals[0].race_date, '2027-03-22');
  assert.equal(request.goals[0].target_time, '2:50:00');
  assert.equal(request.goals[0].finish_only, false);
  assert.equal(request.goals[0].priority, 'A');
  assert.equal(request.availability.weekly_run_days_max, 4);
  assert.deepEqual(request.availability.unavailable_days, ['monday', 'wednesday', 'friday']);
  assert.equal(request.availability.preferred_long_run_day, 'sunday');
  // #1030：三项来自「更多选项」（默认值=代生成口径），不是硬编码臆造
  assert.equal(request.availability.max_session_duration_min, 150);
  assert.equal(request.availability.allows_double_sessions, false);
  assert.equal(request.availability.strength_sessions_per_week, 2);
  assert.deepEqual(request.availability.strength_available_days, ['monday', 'thursday']);
  assert.deepEqual(request.injury_declarations, []);
  assert.equal(request.preferences.length, 2);
  assert.match(request.preferences[0], /每周约 55 公里/);
  assert.match(request.preferences[1], /膝盖偶尔不适/);
  assert.deepEqual(request.user_confirmations, {
    intake_complete: true,
    goals_confirmed: true,
    availability_confirmed: true,
    injury_history_confirmed: true,
    constraints_confirmed: true,
  });
}

// 训练日空：fail-fast，不投递自相矛盾的请求
assert.throws(
  () => buildMasterPlanJobRequest({ ...form, availability: { ...form.availability, weekly_days: [] } }, 'req-x', DEFAULT_MASTER_PLAN_FORM_OPTIONS),
  /weekly_days is empty/,
);

// #1030：更多选项原样进 request（用户改过的值不丢）
{
  const request = buildMasterPlanJobRequest(form, 'req-3', {
    max_session_duration_min: 180,
    allows_double_sessions: true,
    strength_sessions_per_week: 1,
    strength_available_days: ['wednesday'],
  });
  assert.equal(request.availability.max_session_duration_min, 180);
  assert.equal(request.availability.allows_double_sessions, true);
  assert.equal(request.availability.strength_sessions_per_week, 1);
  assert.deepEqual(request.availability.strength_available_days, ['wednesday']);
}

// 力量次数 >0 但没选力量日：fail-fast
assert.throws(
  () =>
    buildMasterPlanJobRequest(form, 'req-4', {
      ...DEFAULT_MASTER_PLAN_FORM_OPTIONS,
      strength_sessions_per_week: 2,
      strength_available_days: [],
    }),
  /strength days required/,
);

// 目标成绩空 = 顺利完赛（target_time null + finish_only true）
{
  const request = buildMasterPlanJobRequest(
    { ...form, goal: { ...form.goal, target_time: '' } },
    'req-2',
    DEFAULT_MASTER_PLAN_FORM_OPTIONS,
  );
  assert.equal(request.goals[0].target_time, null);
  assert.equal(request.goals[0].finish_only, true);
}

// 突破口径：小时×100 + 分
assert.equal(breakthroughNumber('2:50:00'), '250');
assert.equal(breakthroughNumber('3:05:00'), '305');
assert.equal(breakthroughNumber(''), '');

// result_json 解析：服务端按原始 JSON 字符串下发（coach_agent_api toPollResponse）
{
  const content = { goal: { race_name: '无锡马拉松' }, weeks: [] };
  assert.deepEqual(planJobResultContent(JSON.stringify({ content, revision: 3 })), content);
  assert.deepEqual(planJobResultContent({ content, revision: 3 }), content, 'already-parsed object tolerated');
  assert.equal(planJobResultContent(null), null);
  assert.equal(planJobResultContent(''), null);
  assert.equal(planJobResultContent('{broken'), null);
  assert.equal(planJobResultContent(JSON.stringify({ revision: 3 })), null, 'missing content');
}

// 结果卡文案：赛事 + 目标口径 + 日期/周数/峰值
{
  const view = planJobResultView({
    goal: { race_name: '无锡马拉松', distance: 'FM', race_date: '2027-03-22', target_time: '2:50:00' },
    total_weeks: 15,
    weeks: [
      { week_index: 1, target_weekly_km_high: 72 },
      { week_index: 2, target_weekly_km_high: 85 },
      { week_index: 3, target_weekly_km_high: null },
    ],
  });
  assert.ok(view);
  assert.equal(view?.title, '无锡马拉松250突破计划');
  assert.equal(view?.subtitle, '3月22日 · 15 周 · 峰值 85 km');
}

// 完赛目标（无 target_time）与字段缺失的降级
{
  const finishOnly = planJobResultView({
    goal: { race_name: '杭州马拉松', target_time: '', race_date: '2027-11-01' },
    total_weeks: 12,
    weeks: [],
  });
  assert.equal(finishOnly?.title, '杭州马拉松备赛计划');
  assert.equal(finishOnly?.subtitle, '11月1日 · 12 周');

  const degraded = planJobResultView({});
  assert.equal(degraded?.title, '赛季训练计划');
  assert.equal(degraded?.subtitle, '');
}

assert.equal(planJobResultView(null), null, 'null content');
assert.equal(planJobResultView('nope'), null, 'non-object content');

// #1029：网络连续失败只暂停，绝不等价 failed；恢复后原单继续
{
  let failures = 0;
  let paused = false;
  let status: 'running' | 'failed' = 'running';
  for (let i = 0; i < MAX_PLAN_JOB_POLL_FAILURES; i += 1) {
    failures += 1;
    if (planJobPollFailureAction(failures) === 'pause') paused = true;
  }
  assert.equal(paused, true, 'pauses at the failure cap');
  assert.equal(status, 'running', 'network failures never flip the job to failed');
  // 恢复：先探到原单仍在跑 → resume，状态仍 running
  assert.equal(decideRetryAction('running'), 'resume');
  assert.equal(status, 'running');
}

assert.equal(planJobPollFailureAction(1), 'backoff');
assert.equal(planJobPollFailureAction(MAX_PLAN_JOB_POLL_FAILURES - 1), 'backoff');
assert.equal(planJobPollFailureAction(MAX_PLAN_JOB_POLL_FAILURES), 'pause');

assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => planJobPollBackoffMs(n)), [2500, 5000, 10000, 20000, 30000, 30000]);

assert.equal(decideRetryAction('queued'), 'resume');
assert.equal(decideRetryAction('running'), 'resume');
assert.equal(decideRetryAction('done'), 'show-result');
assert.equal(decideRetryAction('failed'), 'repost');
assert.equal(decideRetryAction('gone'), 'repost');

function loadMiniProgram<T>(path: string, register: 'Page' | 'Component', modules: Record<string, unknown>, wx: object = {}): T {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  let definition: T | undefined;
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    require: (name: string) => modules[name] ?? {},
    exports: {},
    wx,
    [register]: (value: T) => { definition = value; },
  });
  assert.ok(definition);
  return definition;
}

type TestMessage = {
  id: number;
  shareIndex?: number;
  hidden?: boolean;
  selectable?: boolean;
  editPlanJobId?: string;
  card?: { type: string };
  planJob?: { jobId: string };
};

// 同一个本地消息 id 在两个会话里对应不同投影序号。请求必须记住发出时的表单。
{
  type Job = planJobCards.PlanJobRecord;
  type FormValues = planJobCards.MasterPlanFormValues;
  type Tap = { currentTarget: { dataset: { id: number | string } } };
  type FormComponent = {
    data: Record<string, unknown>;
    methods: { hydrate(form: MasterPlanFormCard, rememberSource?: boolean): void; reopenForm(values?: FormValues): void };
    observers: { form(form: MasterPlanFormCard): void };
  };
  type CoachPage = {
    data: { currentSessionId: string; messages: TestMessage[]; input: string };
    setData(patch: Record<string, unknown>, afterRender?: () => void): void;
    selectComponent(selector: string): { reopenForm(values?: FormValues): void };
    schedulePlanJobPoll(jobId: string): void;
    onLoad(): void;
    onSelectSession(event: Tap): void;
    loadSession(sessionId: string): Promise<void>;
    onSend(): Promise<void>;
    onPlanFormSubmit(event: Tap & { detail: FormValues }): Promise<void>;
    onPlanJobEdit(event: Tap): void;
    syncPlanJobCards(sessionId: string, messages: TestMessage[]): TestMessage[];
    refreshPlanJobCards(): void;
    finishStream(done: { status: 'completed'; message: string; card: unknown }, userMsgId: number): void;
  };
  const jobs = new Map<string, Job>();
  const enqueue = Promise.withResolvers<{ job_id: string }>();
  const history = Promise.withResolvers<null>();
  const historyRequests: string[] = [];
  const toasts: string[] = [];
  const page = loadMiniProgram<CoachPage>('../pages/coach/coach.ts', 'Page', {
    '../../services/coach': { fetchCoachHistory: (id: string) => { historyRequests.push(id); return history.promise; } },
    '../../services/plan-jobs': { randomRequestId: () => 'req-test', enqueueGenerateMasterPlan: () => enqueue.promise },
    '../../services/master-plan': { isMasterPlanApplied: () => false },
    '../../store/index': { userStore: { getState: () => ({ user: { id: 'runner' } }), waitForAuth: () => new Promise(() => {}) } },
    '../../utils/date': date,
    '../../utils/coachCards': coachCards,
    '../../utils/markdown': { markdownToHtml: (value: string) => value },
    '../../utils/theme': { theme: {} },
    '../../utils/planJobCards': {
      ...planJobCards,
      savePlanJob: (job: Job) => { jobs.set(job.jobId, job); return true; },
      listPlanJobs: () => [...jobs.values()],
      readPlanJobCached: (id: string) => jobs.get(id),
    },
  }, {
    getWindowInfo: () => ({ windowWidth: 375, statusBarHeight: 0 }),
    showToast: ({ title }: { title: string }) => { toasts.push(title); },
  });
  const renderCallbacks: Array<() => void> = [];
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const path = /^messages\[(\d+)\]\.(\w+)$/.exec(key);
      if (path) Reflect.set(page.data.messages[Number(path[1])], path[2], value);
      else Reflect.set(page.data, key, value);
    }
    if (callback) renderCallbacks.push(callback);
  };
  page.schedulePlanJobPoll = () => {};
  const loadSession = page.loadSession.bind(page);
  page.loadSession = async () => {};
  const tap = (id: string | number): Tap => ({ currentTarget: { dataset: { id } } });
  const sourceMessage = { id: 8, shareIndex: 3, card: { type: 'master-plan-form', data: form }, selectable: true };
  const options = { max_session_duration_min: 180, allows_double_sessions: true, strength_sessions_per_week: 1, strength_available_days: ['wednesday'] } satisfies FormValues['options'];
  page.onLoad();
  page.onSelectSession(tap('source'));
  page.data.messages = [sourceMessage];
  const submitted = page.onPlanFormSubmit({ ...tap(sourceMessage.id), detail: { form, options } });
  page.onSelectSession(tap('other'));
  assert.equal(page.data.messages.some((m) => m.card?.type === 'master-plan-form'), false);
  const otherMessage = { ...sourceMessage, shareIndex: 9 };
  page.data.messages = [otherMessage];
  enqueue.resolve({ job_id: 'job-1' });
  await submitted;
  const record = jobs.get('job-1');
  assert.ok(record);
  assert.equal(record.sessionId, 'source');
  assert.equal(record.formShareIndex, sourceMessage.shareIndex);
  assert.deepEqual(page.data.messages, [otherMessage]);

  // 历史重载后使用新消息 id。点击「修改目标」时组件从原始卡片重新挂载。
  record.status = 'done';
  page.onSelectSession(tap('source'));
  page.data.messages = page.syncPlanJobCards('source', [{ ...sourceMessage, id: 17 }]);
  assert.equal(page.data.messages[0].hidden, true);
  assert.equal(page.data.messages[0].selectable, false);
  const component = loadMiniProgram<FormComponent>('../components/master-plan-form-card/index.ts', 'Component', {
    '../../utils/planJobCards': planJobCards,
    '../../utils/weekday': { WEEKDAY_VALUES },
    '../../utils/date': date,
  });
  const instance = { ...component.methods, data: component.data, setData: (patch: object) => Object.assign(component.data, patch) };
  const originalForm = { ...form, goal: { ...form.goal, target_time: '3:30:00' } };
  instance.hydrate(originalForm);
  page.selectComponent = (selector) => {
    assert.equal(selector, '#plan-form-17');
    assert.equal(page.data.messages[0].hidden, false);
    return instance;
  };
  const jobMessage = page.data.messages.find((m) => m.planJob?.jobId === record.jobId);
  assert.ok(jobMessage);
  page.onPlanJobEdit(tap(jobMessage.id));
  assert.equal(component.data.targetHour, 3);
  renderCallbacks.shift()?.();
  assert.equal(component.data.targetHour, 2);
  assert.equal(component.data.targetMinute, 50);
  assert.equal(component.data.maxSessionIndex, 3);
  assert.equal(component.data.allowsDoubleSessions, true);
  assert.equal(component.data.strengthIndex, 1);
  assert.deepEqual(planJobFormValues(record.request), { form: { ...form, goal: { ...form.goal, race_name: form.goal.race_name.trim() } }, options });
  component.observers.form.call(instance, structuredClone(originalForm));
  assert.equal(component.data.targetMinute, 50);

  // 重复点击同一任务时保留当前编辑中的新值。
  component.data.targetMinute = 45;
  page.onPlanJobEdit(tap(jobMessage.id));
  renderCallbacks.shift()?.();
  assert.equal(component.data.targetMinute, 45);

  page.onSelectSession(tap('other'));
  page.onSelectSession(tap('source'));
  record.status = 'running';
  page.data.messages = page.syncPlanJobCards('source', [{ ...sourceMessage, id: 17 }]);
  page.data.messages.push({ id: 40 });
  const newFormReply = { status: 'completed' as const, message: '', card: { $type: 'master-plan-form', data: form } };
  page.finishStream(newFormReply, 40);
  assert.equal(page.data.messages.at(-1)?.hidden, true, '生成中收到的新表单立即隐藏');
  record.status = 'failed';
  page.refreshPlanJobCards();
  assert.equal(page.data.messages[0].hidden, true, '失败任务通过修改目标恢复上次输入');
  assert.equal(page.data.messages.at(-1)?.hidden, false, '生成结束后尚未提交的新表单恢复');

  const legacy = { ...record, jobId: 'legacy', sessionId: 'legacy', formMessageId: 17, formShareIndex: undefined };
  jobs.set(legacy.jobId, legacy);
  page.onSelectSession(tap('legacy'));
  page.data.messages = page.syncPlanJobCards('legacy', [{ ...sourceMessage, id: 18 }]);
  assert.equal(page.data.messages[0].hidden, true, '旧任务可匹配历史中唯一且赛事相同的表单');
  page.data.messages = page.syncPlanJobCards('legacy', [{ ...sourceMessage, id: 17 }, { ...otherMessage, id: 18 }]);
  assert.equal(page.data.messages[0].hidden, undefined, '旧 id 有歧义时保留历史表单');
  const legacyMessage = page.data.messages.find((m) => m.planJob?.jobId === legacy.jobId);
  assert.ok(legacyMessage);
  page.selectComponent = (selector) => {
    const draft = page.data.messages.find((m) => m.editPlanJobId === legacy.jobId);
    assert.ok(draft);
    assert.equal(selector, `#plan-form-${draft.id}`);
    assert.equal(draft.selectable, false);
    return { reopenForm: (values) => assert.deepEqual(values, planJobFormValues(legacy.request)) };
  };
  page.onPlanJobEdit(tap(legacyMessage.id));
  renderCallbacks.shift()?.();
  assert.ok(page.data.messages.find((m) => m.editPlanJobId === legacy.jobId));

  let loading: Promise<void> | undefined;
  page.loadSession = (id) => { loading = loadSession(id); return loading; };
  page.onSelectSession(tap('source'));
  page.data.input = '我要准备马拉松';
  await page.onSend();
  assert.equal(page.data.input, '我要准备马拉松', '历史加载中保留输入');
  assert.equal(toasts.at(-1), '对话加载中，请稍候');
  history.reject(new Error('offline'));
  await loading;
  assert.ok(page.data.messages.some((m) => m.planJob?.jobId === record.jobId), '历史不可用时保留本地任务卡');
  page.data.messages.push({ id: 42 });
  page.finishStream(newFormReply, 42);
  assert.equal(page.data.messages.at(-1)?.shareIndex, undefined, '历史未知时不猜测新表单的序号');
  page.onSelectSession(tap('source'));
  await loading;
  assert.deepEqual(historyRequests, ['source', 'source']);
}

// 本地存储部分失败时，列表和轮询仍使用本进程的最新任务状态。
{
  const storage = new Map<string, unknown>();
  let blockedKey = '';
  Object.defineProperty(globalThis, 'wx', {
    configurable: true,
    value: {
      getStorageSync: (key: string) => storage.get(key),
      setStorageSync: (key: string, value: unknown) => {
        if (key === blockedKey) throw new Error('quota');
        storage.set(key, value);
      },
      removeStorageSync: (key: string) => storage.delete(key),
    },
  });
  const record: planJobCards.PlanJobRecord = {
    jobId: 'storage-test', sessionId: 'source', status: 'running', stage: '', progressPct: 0,
    createdAt: 1, idempotencyKey: 'storage-test', request: buildMasterPlanJobRequest(form, 'storage', DEFAULT_MASTER_PLAN_FORM_OPTIONS),
  };
  try {
    assert.equal(planJobCards.savePlanJob(record), true);
    blockedKey = 'plan-job:storage-test';
    planJobCards.updatePlanJobRecord(record.jobId, { status: 'done' });
    assert.equal(planJobCards.readPlanJobCached(record.jobId)?.status, 'done');
    assert.equal(planJobCards.listPlanJobs()[0]?.status, 'done');
    blockedKey = 'plan-job:index';
    assert.equal(planJobCards.savePlanJob({ ...record, jobId: 'index-test', createdAt: 2 }), false);
    assert.deepEqual(planJobCards.listPlanJobs().map(({ jobId }) => jobId), ['storage-test', 'index-test']);
  } finally {
    blockedKey = '';
    planJobCards.removePlanJob(record.jobId);
    planJobCards.removePlanJob('index-test');
    Reflect.deleteProperty(globalThis, 'wx');
  }
}

console.log('plan job cards checks passed');
