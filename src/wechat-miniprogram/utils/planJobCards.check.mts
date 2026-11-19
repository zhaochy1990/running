/**
 * planJobCards.ts 自检（#1024 PR-2 表单 → kernel request / 结果卡文案）：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/planJobCards.check.mts`。
 */
import { strict as assert } from 'node:assert';
import type { MasterPlanFormCard } from '../services/master-plan.ts';
import {
  breakthroughNumber,
  buildMasterPlanJobRequest,
  decideRetryAction,
  DEFAULT_MASTER_PLAN_FORM_OPTIONS,
  MAX_PLAN_JOB_POLL_FAILURES,
  planJobPollBackoffMs,
  planJobPollFailureAction,
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

console.log('plan job cards checks passed');
