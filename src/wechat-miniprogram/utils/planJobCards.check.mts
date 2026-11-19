/**
 * planJobCards.ts 自检（#1024 PR-2 表单 → kernel request / 结果卡文案）：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/planJobCards.check.mts`。
 */
import { strict as assert } from 'node:assert';
import type { MasterPlanFormCard } from '../services/master-plan.ts';
import { breakthroughNumber, buildMasterPlanJobRequest, planJobResultContent, planJobResultView } from './planJobCards.ts';

const form: MasterPlanFormCard = {
  goal: { race_name: ' 无锡马拉松 ', distance: 'FM', race_date: '2027-03-22', target_time: '2:50:00' },
  availability: { weekly_days: ['tuesday', 'thursday', 'saturday', 'sunday'], preferred_long_run_day: 'sunday' },
  base: '每周约 55 公里',
  restriction: '膝盖偶尔不适',
};

// 表单 → kernel request：目标成绩/完赛 XOR、训练日补集、自由文本进 preferences
{
  const request = buildMasterPlanJobRequest(form, 'req-1');
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
  assert.equal(request.availability.max_session_duration_min, 120);
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
  () => buildMasterPlanJobRequest({ ...form, availability: { ...form.availability, weekly_days: [] } }, 'req-x'),
  /weekly_days is empty/,
);

// 目标成绩空 = 顺利完赛（target_time null + finish_only true）
{
  const request = buildMasterPlanJobRequest(
    { ...form, goal: { ...form.goal, target_time: '' } },
    'req-2',
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

console.log('plan job cards checks passed');
