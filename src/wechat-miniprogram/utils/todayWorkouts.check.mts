import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as plan from '../services/plan.ts';
import type { PlanSessionRow, TodayWorkoutView } from '../types/plan.ts';
import * as dates from './date.ts';
import * as format from './format.ts';

const day = '2026-11-27';
const restDay = '2026-11-28';
const emptyDay = '2026-11-29';
const previousDay = '2026-11-26';
const expiredDay = '2026-11-19';
const customNote = '先补给，再进入主课。\n结束后慢跑放松。';
const strengthNote = '动作稳定后再加负重。';
mock.timers.enable({ apis: ['Date'], now: Date.parse(`${day}T08:00:00+08:00`) });
const session = (workoutId: string, patch: Partial<PlanSessionRow> = {}): PlanSessionRow => ({
  workout_id: workoutId,
  date: day,
  source: 'weekly',
  kind: 'run',
  name: workoutId,
  summary: null,
  spec: null,
  total_distance_m: null,
  total_duration_s: null,
  estimated_dose: null,
  session_index: null,
  plan_id: null,
  provider: null,
  provider_entity_id: null,
  pushed: false,
  save_token: null,
  ...patch,
});
const rows = [
  session('note', { kind: 'note' }),
  session('easy-run', { session_index: 0 }),
  session('legacy-run', { spec: JSON.parse('{"name":"旧版跑课"}') }),
  session('strength', { kind: 'strength', session_index: 1, spec: { name: '力量', date: day, note: strengthNote, exercises: [] } }),
  session('custom-a', { source: 'custom' }),
  session('custom-b', { source: 'custom', spec: { name: '自建跑课', date: day, note: customNote, blocks: [] } }),
  session('watch', { source: 'watch' }),
  session('rest', { date: restDay, kind: 'rest' }),
  session('past-custom', { date: previousDay, source: 'custom', spec: { name: '昨天的跑课', date: previousDay, note: null, blocks: [] } }),
  session('expired-custom', { date: expiredDay, source: 'custom', spec: { name: '过期跑课', date: expiredDay, note: null, blocks: [] } }),
];

type CardEvent = { currentTarget: { dataset: { workoutId: string; foldControl: boolean } } };
type ActivityEvent = { currentTarget: { dataset: { id: string } } };
type PageUnderTest = {
  data: {
    workouts: TodayWorkoutView[];
    todayActivities: Array<{ labelId: string; manualStrengthLabel: string }>;
    canContinueStrength: boolean;
    expandedWorkouts: Record<string, boolean>;
    pushOptions: { value: string }[];
    pushWorkout: TodayWorkoutView | null;
  };
  setData(patch: object): void;
  onLoad(): void;
  fetchWeekSessions(date: string): Promise<void>;
  onDayTap(event: { currentTarget: { dataset: { date: string } } }): void;
  onWorkoutCardTap(event: CardEvent): void;
  onTodayActivityTap(event: ActivityEvent): void;
  onContinueStrengthTap(event: ActivityEvent): void;
  onCoachTap(event: CardEvent): void;
  onWatchTap(event: CardEvent): void;
  onMoreTap(event: CardEvent): void;
  onPushDateClose(): void;
  onPushDateSelect(event: { detail: { value: string } }): Promise<void>;
  onShareAppMessage(event: { target: { dataset: { share: string; workoutId: string } } }): { path: string };
};
const user = { id: 'test-user' };
const detailUrls: string[] = [];
const coachTargets: unknown[] = [];
const pushes: unknown[][] = [];
const customPushes: unknown[][] = [];
const deletes: unknown[][] = [];
const activityRequests: Array<{ dateFrom: string; dateTo: string; includeManualStrength: boolean }> = [];
const manualActivity = (labelId: string) => ({
  label_id: labelId, name: labelId, source: 'manual_strength', sport_name: 'Strength', duration_s: null,
  manual_strength_summary: { action_count: 2, set_count: 3 },
});
let availableRows = rows;
let chooseDelete: (() => void) | undefined;

const modules: Record<string, unknown> = {
  '../../services/plan': {
    ...plan,
    getWeeklyPlan: async () => ({
      content: {
        coach_notes: '整周排课依据',
        notes_md: '本周训练逻辑',
        sessions: [{ date: day, session_index: 0, notes_md: '周文档里的课次备注' }],
        nutrition: [],
      },
    }),
    getPlanSessions: async (_uid: string, from: string, to: string) => ({
      sessions: availableRows.filter(({ date }) => date >= from && date <= to),
    }),
    pushPlannedSession: async (...args: unknown[]) => { pushes.push(args); },
    pushCustomWorkout: async (...args: unknown[]) => { customPushes.push(args); },
    deleteCustomWorkout: async (...args: unknown[]) => { deletes.push(args); },
  },
  '../../services/activities': {
    getActivities: async (_uid: string, params: (typeof activityRequests)[number]) => {
      activityRequests.push(params);
      return {
        activities: params.dateFrom === day
          ? [manualActivity('manual-a'), manualActivity('manual-b'), { label_id: 'watch', name: '手表力量训练', source: 'watch' }]
          : [manualActivity('older-manual')],
      };
    },
  },
  '../../services/coach': { setPendingCoachContext: (context: unknown) => coachTargets.push(context) },
  '../../utils/date': { ...dates, shanghaiToday: () => day },
  '../../utils/format': format,
  '../../utils/theme': { theme: {} },
  '../../utils/manual-strength': { getStrengthDraft: () => null },
  '../../store/index': { userStore: { getState: () => ({ user, isAuthenticated: true }), waitForAuth: async () => {} } },
};

let page: PageUnderTest | undefined;
const source = readFileSync(new URL('../pages/index/index.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
runInNewContext(js, {
  exports: {},
  require: (path: string) => modules[path] ?? {},
  Page: (definition: PageUnderTest) => { page = definition; },
  wx: {
    getWindowInfo: () => ({ statusBarHeight: 0, windowWidth: 375 }),
    navigateTo: ({ url }: { url: string }) => detailUrls.push(url),
    switchTab: () => {},
    showActionSheet: (options: { success(result: { tapIndex: number }): void }) => {
      chooseDelete = () => options.success({ tapIndex: 0 });
    },
    showModal: (options: { success(result: { confirm: boolean }): void }) => options.success({ confirm: true }),
    showLoading: () => {},
    hideLoading: () => {},
    showToast: () => {},
  },
});

assert.ok(page);
const view = page;
view.setData = (patch) => { Object.assign(view.data, patch); };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const tapCard = (workoutId: string, foldControl = false): CardEvent => ({
  currentTarget: { dataset: { workoutId, foldControl } },
});
const tapDay = (date: string) => view.onDayTap({ currentTarget: { dataset: { date } } });

view.onLoad();
await settle();
const workoutIds = () => Array.from(view.data.workouts ?? [], (w) => w.workoutId);
assert.deepEqual(workoutIds(), ['easy-run', 'legacy-run', 'strength', 'custom-a', 'custom-b', 'watch']);
assert.equal(view.data.workouts[1].hasStructure, false);
assert.deepEqual(Array.from(view.data.workouts, (workout) => workout.note), ['', '', strengthNote, '', customNote, '']);
assert.deepEqual(Object.keys(view.data.expandedWorkouts), []);

const template = readFileSync(new URL('../pages/index/index.wxml', import.meta.url), 'utf8');
const cardBindings = (template.match(/<(?:view|button)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g) ?? [])
  .filter((tag) => tag.includes('data-workout-id="{{workout.workoutId}}"'));
const card = cardBindings.find((tag) => tag.includes('bindtap="onWorkoutCardTap"'));
assert.ok(card?.includes('wx:for="{{workouts}}"') && card.includes('wx:for-item="workout"'));
assert.ok(cardBindings.some((tag) => tag.includes('catchtap="onWorkoutCardTap"') && tag.includes('data-fold-control="{{true}}"')));
for (const handler of ['onWatchTap', 'onMoreTap', 'onCoachTap', 'onShareTap']) {
  assert.ok(cardBindings.some((tag) => tag.includes(`catchtap="${handler}"`)), `${handler} needs its card's workout ID`);
}

view.onWorkoutCardTap(tapCard('strength'));
assert.equal(view.data.expandedWorkouts.strength, true);
assert.deepEqual(detailUrls, []);
view.onWorkoutCardTap(tapCard('easy-run', true));
assert.equal(view.data.expandedWorkouts['easy-run'], true);
view.onWorkoutCardTap(tapCard('easy-run', true));
assert.equal(view.data.expandedWorkouts['easy-run'], false);
await view.fetchWeekSessions(day);
assert.equal(view.data.expandedWorkouts.strength, true);
view.onWorkoutCardTap(tapCard('strength'));
assert.equal(detailUrls[0], `/pages/workout-detail/workout-detail?date=${day}&workoutId=strength&title=strength`);
view.onCoachTap(tapCard('strength'));
assert.deepEqual(JSON.parse(JSON.stringify(coachTargets[0])).target, {
  kind: 'session', date: day, session_index: 1,
});
const share = view.onShareAppMessage({ target: { dataset: { share: 'today', workoutId: 'custom-b' } } });
assert.equal(share.path, '/pages/workout-share/workout-share?user=test-user&workout=custom-b');

view.onWatchTap(tapCard('strength'));
assert.ok(view.data.pushOptions.some(({ value }) => value === restDay));
tapDay(restDay);
assert.deepEqual(workoutIds(), ['rest']);
assert.equal(view.data.expandedWorkouts.strength, undefined);
await view.onPushDateSelect({ detail: { value: restDay } });
assert.deepEqual(pushes, [[user.id, day, 1, restDay]]);

tapDay(day);
assert.equal(view.data.expandedWorkouts.strength, undefined);
view.onWatchTap(tapCard('custom-b'));
await view.onPushDateSelect({ detail: { value: restDay } });
assert.deepEqual(customPushes, [['custom-b', restDay]]);

view.onMoreTap(tapCard('custom-b'));
tapDay(emptyDay);
assert.deepEqual(workoutIds(), []);
assert.ok(chooseDelete);
chooseDelete();
await settle();
assert.deepEqual(deletes, [[user.id, 'custom-b']]);

tapDay(day);
view.onWatchTap(tapCard('strength'));
availableRows = rows.map((row) => row.workout_id === 'strength' ? { ...row, workout_id: 'new-strength' } : row);
await view.onPushDateSelect({ detail: { value: restDay } });
assert.deepEqual(pushes, [[user.id, day, 1, restDay]], 'a replaced session must not be pushed');

tapDay(previousDay);
view.onWorkoutCardTap(tapCard('past-custom', true));
assert.equal(detailUrls.at(-1), `/pages/workout-detail/workout-detail?date=${previousDay}&workoutId=past-custom&title=past-custom`);
view.onWatchTap(tapCard('past-custom'));
assert.equal(view.data.pushWorkout?.workoutId, 'past-custom');
assert.equal(view.data.pushOptions.at(-1)?.value, '2026-12-03');
view.onPushDateClose();

tapDay(expiredDay);
await settle();
assert.deepEqual(workoutIds(), ['expired-custom']);
view.onWatchTap(tapCard('expired-custom'));
assert.equal(view.data.pushWorkout, null);

const tapActivity = (id: string): ActivityEvent => ({ currentTarget: { dataset: { id } } });
assert.equal(view.data.todayActivities[0].manualStrengthLabel, '手动记录 · 2 个动作 · 3 组');
assert.equal(view.data.canContinueStrength, false);
const beforeExpiredTap = detailUrls.length;
view.onContinueStrengthTap(tapActivity('older-manual'));
assert.equal(detailUrls.length, beforeExpiredTap);
view.onTodayActivityTap(tapActivity('older-manual'));
assert.equal(detailUrls.at(-1), '/pages/manual-strength-detail/manual-strength-detail?recordId=older-manual');

tapDay(previousDay);
await settle();
assert.equal(view.data.canContinueStrength, true);
view.onContinueStrengthTap(tapActivity('older-manual'));
assert.equal(detailUrls.at(-1), '/pages/manual-strength/manual-strength?resume=older-manual');

tapDay(day);
await settle();
assert.equal(view.data.canContinueStrength, true);
assert.ok(activityRequests.some((params) => params.dateFrom === day && params.dateTo === day && params.includeManualStrength));
assert.deepEqual(Array.from(view.data.todayActivities, ({ labelId }) => labelId), ['manual-a', 'manual-b', 'watch']);
view.onContinueStrengthTap(tapActivity('manual-b'));
assert.equal(detailUrls.at(-1), '/pages/manual-strength/manual-strength?resume=manual-b');
view.onTodayActivityTap(tapActivity('watch'));
assert.equal(detailUrls.at(-1), '/pages/activity-detail/activity-detail?labelId=watch');

mock.timers.reset();
console.log('todayWorkouts.check: all assertions passed');
