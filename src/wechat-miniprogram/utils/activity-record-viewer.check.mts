import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as dates from './date.ts';
import * as format from './format.ts';
import * as strength from './manual-strength.ts';
import { theme } from './theme.ts';
import type { ManualStrengthSummary } from '../types/manual-strength.ts';

type ActivityResponse = { total: number; activities: Array<{ label_id: string; name: string; date: string; source: string; manual_strength_summary?: ManualStrengthSummary }> };
type PageUnderTest = {
  data: { guest: boolean; monthGroups: Array<{ rows: Array<{ name: string; strengthSummary: string }> }> };
  setData(patch: object): void;
  onLoad(): Promise<void>;
  onShow(): void;
  fetch(): Promise<void>;
};

let page: PageUnderTest | undefined;
let viewerId = 'user-a';
let viewerChanged: (() => void) | undefined;
let listVersion = 0;
let editedSummaries: Map<string, { name: string; summary: ManualStrengthSummary }> | undefined;
const requests: Array<{ viewer: string; resolve(response: ActivityResponse): void }> = [];
const source = readFileSync(new URL('../pages/activities/activities.ts', import.meta.url), 'utf8');
const script = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
runInNewContext(script, {
  exports: {},
  Page: (definition: PageUnderTest) => { page = definition; },
  wx: { getWindowInfo: () => ({ statusBarHeight: 48, windowWidth: 390 }) },
  require: (path: string) => ({
    '../../services/activities': {
      getActivities: (viewer: string) => new Promise<ActivityResponse>((resolve) => requests.push({ viewer, resolve })),
    },
    '../../services/manual-strength': {
      manualStrengthListVersion: () => listVersion,
      takeManualStrengthEditedSummaries: () => {
        const result = editedSummaries;
        editedSummaries = undefined;
        return result;
      },
    },
    '../../utils/date': dates,
    '../../utils/format': format,
    '../../utils/share': {},
    '../../store/index': {
      userStore: {
        waitForAuth: async () => undefined,
        getState: () => ({ isAuthenticated: Boolean(viewerId), user: viewerId ? { id: viewerId } : null }),
        subscribe: (listener: () => void) => {
          viewerChanged = listener;
          return () => { viewerChanged = undefined; };
        },
      },
    },
  })[path],
});

assert.ok(page);
const view = page;
view.setData = (patch) => { Object.assign(view.data, patch); };
async function respond(viewer: string, name: string) {
  const request = requests.shift();
  assert.equal(request?.viewer, viewer);
  request?.resolve({
    total: 1,
    activities: [{ label_id: name, name, date: '2026-11-26T15:00:00+08:00', source: 'manual_strength', manual_strength_summary: { action_count: 2, set_count: 3 } }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

await view.onLoad();
await respond('user-a', '账号 A 私人训练');
assert.equal(view.data.monthGroups[0].rows[0].name, '账号 A 私人训练');
assert.equal(view.data.monthGroups[0].rows[0].strengthSummary, '2 个动作 · 3 组');
editedSummaries = new Map([['账号 A 私人训练', { name: '编辑后的历史训练', summary: { action_count: 2, set_count: 4 } }]]);
view.onShow();
assert.equal(view.data.monthGroups[0].rows[0].name, '编辑后的历史训练');
assert.equal(view.data.monthGroups[0].rows[0].strengthSummary, '2 个动作 · 4 组');
const refreshing = view.fetch();
viewerId = '';
viewerChanged?.();
view.onShow();
assert.equal(view.data.guest, true);
assert.equal(view.data.monthGroups.length, 0);
await respond('user-a', '账号 A 晚到的响应');
await refreshing;
assert.equal(view.data.monthGroups.length, 0);

viewerId = 'user-b';
viewerChanged?.();
await respond('user-b', '账号 B 私人训练');
assert.equal(view.data.guest, false);
assert.equal(view.data.monthGroups[0].rows[0].name, '账号 B 私人训练');
assert.equal(requests.length, 0);

const beforeDelete = view.fetch();
listVersion++;
view.onShow();
await respond('user-b', '晚到的已删除记录');
assert.equal(view.data.monthGroups[0].rows[0].name, '账号 B 私人训练');
const afterDelete = requests.shift();
assert.equal(afterDelete?.viewer, 'user-b');
afterDelete?.resolve({ total: 0, activities: [] });
await beforeDelete;
assert.equal(view.data.monthGroups.length, 0);

const savedRecord = {
  id: 'saved', name: '账号 A 的历史训练', note: '账号 A 的备注', actions: [{
    name: '深蹲', sets: [
      { load: '20', load_unit: 'kg', quantity: 10, quantity_unit: 'reps' },
      { load: '25', load_unit: 'kg', quantity: 8, quantity_unit: 'reps' },
    ],
  }],
  revision: 1, started_at: '2026-11-26T07:00:00Z', ended_at: '2026-11-26T07:30:00Z',
};
type TrainingPage = {
  data: { draft?: unknown; record?: unknown; summaryLabel?: string; actionRows?: Array<{ sets: Array<{ number: number }> }> };
  setData(patch: object): void;
  onLoad(params: { edit?: string; recordId?: string }): Promise<void> | void;
  onShow?(): void;
  onCoachReview?(): void;
  onDelete?(): Promise<void>;
};
const coachHandoffs: Array<{ recordId: string; userId: string }> = [];
const deletions: Array<{ recordId: string; userId: string }> = [];
const toasts: string[] = [];
let confirmDelete = async () => ({ confirm: false });
let failDeletion = false;
let navigatedBack = 0;
async function loadTrainingPage(relative: string): Promise<TrainingPage> {
  let definition: TrainingPage | undefined;
  viewerId = 'user-a';
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const script = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  runInNewContext(script, {
    exports: {},
    Page: (page: TrainingPage) => { definition = page; },
    wx: {
      setNavigationBarTitle: () => undefined,
      disableAlertBeforeUnload: () => undefined,
      showModal: () => confirmDelete(),
      showToast: ({ title }: { title: string }) => toasts.push(title),
      navigateBack: () => { navigatedBack++; },
    },
    require: (path: string) => ({
      '../../services/manual-strength': {
        getManualStrengthRecord: async () => savedRecord,
        deleteManualStrengthRecord: async (userId: string, recordId: string) => {
          deletions.push({ userId, recordId });
          if (failDeletion) throw new Error('network');
        },
      },
      '../../services/coach': { openStrengthReview: (recordId: string, userId: string) => coachHandoffs.push({ recordId, userId }) },
      '../../services/request': {},
      '../../utils/date': dates,
      '../../utils/manual-strength': { ...strength, getStrengthDraft: () => undefined },
      '../../utils/theme': { theme },
      '../../store/index': {
        userStore: {
          waitForAuth: async () => undefined,
          getState: () => ({ isAuthenticated: Boolean(viewerId), user: viewerId ? { id: viewerId } : null }),
          subscribe: (listener: (state: { isAuthenticated: boolean; user: { id: string } | null }) => void) => {
            viewerChanged = () => listener({ isAuthenticated: Boolean(viewerId), user: viewerId ? { id: viewerId } : null });
            return () => { viewerChanged = undefined; };
          },
        },
      },
    })[path],
  });
  assert.ok(definition);
  const page = definition;
  page.setData = (patch) => { Object.assign(page.data, patch); };
  await page.onLoad({ edit: 'saved', recordId: 'saved' });
  page.onShow?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return page;
}

const edit = await loadTrainingPage('../pages/manual-strength/manual-strength.ts');
assert.ok(edit.data.draft);
viewerId = '';
viewerChanged?.();
assert.equal(edit.data.draft, null);

const detail = await loadTrainingPage('../pages/manual-strength-detail/manual-strength-detail.ts');
assert.ok(detail.data.record);
assert.equal(detail.data.summaryLabel, '手动记录 · 1 个动作 / 2 组');
assert.equal(detail.data.actionRows?.[0].sets[0].number, 1);
assert.equal(detail.data.actionRows?.[0].sets[1].number, 2);
detail.onCoachReview?.();
assert.deepEqual(coachHandoffs, [{ recordId: 'saved', userId: 'user-a' }]);
viewerId = 'user-b';
viewerChanged?.();
detail.onShow?.();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(detail.data.record, null);
assert.equal(detail.data.actionRows?.length, 0);
assert.equal(detail.data.summaryLabel, '');
detail.onCoachReview?.();
assert.equal(coachHandoffs.length, 1);

const deletable = await loadTrainingPage('../pages/manual-strength-detail/manual-strength-detail.ts');
await deletable.onDelete?.();
assert.equal(deletions.length, 0);
assert.ok(deletable.data.record);

confirmDelete = async () => ({ confirm: true });
failDeletion = true;
await deletable.onDelete?.();
assert.ok(deletable.data.record);
assert.equal(navigatedBack, 0);
assert.deepEqual(toasts, ['删除失败，请重试']);

failDeletion = false;
await Promise.all([deletable.onDelete?.(), deletable.onDelete?.()]);
assert.deepEqual(deletions, [
  { recordId: 'saved', userId: 'user-a' },
  { recordId: 'saved', userId: 'user-a' },
]);
assert.equal(deletable.data.record, null);
assert.equal(navigatedBack, 1);
assert.deepEqual(toasts, ['删除失败，请重试', '已删除']);

const switched = await loadTrainingPage('../pages/manual-strength-detail/manual-strength-detail.ts');
confirmDelete = async () => {
  viewerId = 'user-b';
  viewerChanged?.();
  return { confirm: true };
};
await switched.onDelete?.();
assert.equal(deletions.length, 2);
console.log('activity-record-viewer.check: all assertions passed');
