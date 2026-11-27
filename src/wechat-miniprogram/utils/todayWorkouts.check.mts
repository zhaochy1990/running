import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as plan from '../services/plan.ts';
import type { PlanSessionRow, TodayWorkoutView } from '../types/plan.ts';
import * as dates from './date.ts';

const day = '2026-11-27';
const restDay = '2026-11-28';
const emptyDay = '2026-11-29';
const session = (workout_id: string, patch: Partial<PlanSessionRow> = {}): PlanSessionRow => ({
  workout_id,
  date: day,
  source: 'weekly',
  kind: 'run',
  name: workout_id,
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
  session('strength', { kind: 'strength', session_index: 1, spec: { name: '力量', date: day, note: null, exercises: [] } }),
  session('custom-a', { source: 'custom' }),
  session('custom-b', { source: 'custom', spec: { name: '自建跑课', date: day, note: null, blocks: [] } }),
  session('watch', { source: 'watch' }),
  session('rest', { date: restDay, kind: 'rest' }),
];

type CardEvent = { currentTarget: { dataset: { workoutId: string } } };
type PageUnderTest = {
  data: { workouts: TodayWorkoutView[]; pushOptions: { value: string }[] };
  setData(patch: object): void;
  onLoad(): void;
  onDayTap(event: { currentTarget: { dataset: { date: string } } }): void;
  onWorkoutCardTap(event: CardEvent): void;
  onCoachTap(event: CardEvent): void;
  onWatchTap(event: CardEvent): void;
  onMoreTap(event: CardEvent): void;
  onPushDateSelect(event: { detail: { value: string } }): Promise<void>;
  onShareAppMessage(event: { target: { dataset: { share: string; workoutId: string } } }): { path: string };
};
const user = { id: 'test-user' };
const detailUrls: string[] = [];
const coachTargets: unknown[] = [];
const pushes: unknown[][] = [];
const customPushes: string[] = [];
const deletes: unknown[][] = [];
let chooseDelete: (() => void) | undefined;

const modules: Record<string, unknown> = {
  '../../services/plan': {
    ...plan,
    getWeeklyPlan: async () => null,
    getPlanSessions: async () => ({ sessions: rows }),
    pushPlannedSession: async (...args: unknown[]) => { pushes.push(args); },
    pushCustomWorkout: async (workoutId: string) => { customPushes.push(workoutId); },
    deleteCustomWorkout: async (...args: unknown[]) => { deletes.push(args); },
  },
  '../../services/activities': { getActivities: async () => ({ activities: [] }) },
  '../../services/coach': { setPendingCoachContext: (context: unknown) => coachTargets.push(context) },
  '../../utils/date': { ...dates, shanghaiToday: () => day },
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
const tapCard = (workoutId: string): CardEvent => ({ currentTarget: { dataset: { workoutId } } });
const tapDay = (date: string) => view.onDayTap({ currentTarget: { dataset: { date } } });

view.onLoad();
await settle();
const workoutIds = () => Array.from(view.data.workouts ?? [], (w) => w.workoutId);
assert.deepEqual(workoutIds(), ['easy-run', 'strength', 'custom-a', 'custom-b', 'watch']);

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
await view.onPushDateSelect({ detail: { value: restDay } });
assert.deepEqual(pushes, [[user.id, day, 1, restDay]]);

tapDay(day);
view.onWatchTap(tapCard('custom-b'));
await view.onPushDateSelect({ detail: { value: day } });
assert.deepEqual(customPushes, ['custom-b']);

view.onMoreTap(tapCard('custom-b'));
tapDay(emptyDay);
assert.deepEqual(workoutIds(), []);
assert.ok(chooseDelete);
chooseDelete();
await settle();
assert.deepEqual(deletes, [[user.id, 'custom-b']]);

console.log('todayWorkouts.check: all assertions passed');
