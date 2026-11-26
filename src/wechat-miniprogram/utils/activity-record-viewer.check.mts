import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as dates from './date.ts';
import * as format from './format.ts';
import * as strength from './manual-strength.ts';
import { theme } from './theme.ts';
import type { ManualStrengthSummary } from '../types/manual-strength.ts';

type ActivityResponse = { total: number; activities: Array<{ label_id: string; name: string; date: string; source: string; duration_s: number; manual_strength_summary?: ManualStrengthSummary }> };
type PageUnderTest = {
  data: { guest: boolean; total: number; summaryStale: boolean; monthGroups: Array<{ summary: { count: number }; duration: string; rows: Array<{ name: string; strengthSummary: string }> }> };
  setData(patch: object): void;
  onLoad(): Promise<void>;
  onShow(): void;
  onLoadMore(): Promise<void>;
  fetch(): Promise<void>;
};

let page: PageUnderTest | undefined;
let viewerId = 'user-a';
let viewerChanged: (() => void) | undefined;
let listVersion = 0;
let strengthDeleted: ((userId: string, recordId: string) => void) | undefined;
let editedSummaries: Map<string, { name: string; summary: ManualStrengthSummary }> | undefined;
const requests: Array<{ viewer: string; resolve(response: ActivityResponse): void; reject(error: Error): void }> = [];
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
      getActivities: (viewer: string) => new Promise<ActivityResponse>((resolve, reject) => requests.push({ viewer, resolve, reject })),
    },
    '../../services/manual-strength': {
      manualStrengthListVersion: () => listVersion,
      subscribeManualStrengthDeletion: (listener: typeof strengthDeleted) => {
        strengthDeleted = listener;
        return () => { strengthDeleted = undefined; };
      },
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
async function respond(viewer: string, name: string, includeWatch = false) {
  const request = requests.shift();
  assert.equal(request?.viewer, viewer);
  const activities: ActivityResponse['activities'] = [{
    label_id: name, name, date: '2026-11-26T15:00:00+08:00', source: 'manual_strength', duration_s: 300,
    manual_strength_summary: { action_count: 2, set_count: 3 },
  }];
  if (includeWatch) activities.push({
    label_id: 'watch', name: '手表力量训练', date: '2026-11-26T15:00:00+08:00', source: 'watch', duration_s: 600,
  });
  request?.resolve({ total: activities.length, activities });
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
await respond('user-b', '账号 B 私人训练', true);
assert.equal(view.data.guest, false);
assert.equal(view.data.monthGroups[0].rows[0].name, '账号 B 私人训练');
assert.equal(requests.length, 0);

const beforeDelete = view.fetch();
view.onShow();
strengthDeleted?.('user-a', '账号 B 私人训练');
assert.equal(view.data.total, 2);
listVersion++;
strengthDeleted?.('user-b', '账号 B 私人训练');
assert.equal(view.data.total, 1);
assert.equal(view.data.monthGroups[0].summary.count, 1);
assert.equal(view.data.monthGroups[0].duration, '10:00');
assert.equal(view.data.monthGroups[0].rows[0].name, '手表力量训练');
await respond('user-b', '晚到的已删除记录');
const afterDelete = requests.shift();
assert.equal(afterDelete?.viewer, 'user-b');
afterDelete?.reject(new Error('network'));
await beforeDelete;
assert.equal(view.data.monthGroups[0].rows[0].name, '手表力量训练');
assert.equal(view.data.monthGroups[0].summary.count, 1);

listVersion++;
strengthDeleted?.('user-b', '未缓存的较早训练');
assert.equal(view.data.summaryStale, true);
const failedSummaryRefresh = requests.shift();
assert.equal(failedSummaryRefresh?.viewer, 'user-b');
failedSummaryRefresh?.reject(new Error('network'));
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(view.data.summaryStale, true);
const retrySummary = view.onLoadMore();
await respond('user-b', '重新验证的活动');
await retrySummary;
assert.equal(view.data.summaryStale, false);
assert.equal(view.data.monthGroups[0].summary.count, 1);

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
  data: { draft?: strength.StrengthDraft | null; record?: unknown; summaryLabel?: string; actionRows?: Array<{ sets: Array<{ number: number }> }>; error?: string; canDiscardDraft?: boolean };
  setData(patch: object): void;
  onLoad(params: { edit?: string; recordId?: string }): Promise<void> | void;
  onShow?(): void;
  onCoachReview?(): void;
  onDelete?(): Promise<void>;
  onSave?(): Promise<void>;
  onDiscardDraft?(): Promise<void>;
};
class TestApiError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number) {
    super(String(statusCode));
    this.statusCode = statusCode;
  }
}
const coachHandoffs: Array<{ recordId: string; userId: string }> = [];
const deletions: Array<{ recordId: string; userId: string }> = [];
const saves: string[] = [];
const toasts: string[] = [];
let confirmDelete = async () => ({ confirm: false });
let failDeletion = false;
let navigatedBack = 0;
let activeDraft: strength.StrengthDraft | undefined;
async function loadTrainingPage(
  relative: string,
  options: { edit?: string; recordId?: string } = { edit: 'saved', recordId: 'saved' },
): Promise<TrainingPage> {
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
      pageScrollTo: () => undefined,
    },
    require: (path: string) => ({
      '../../services/manual-strength': {
        getManualStrengthRecord: async () => savedRecord,
        saveManualStrengthRecord: async (_userId: string, recordId: string) => {
          saves.push(recordId);
          throw new TestApiError(404);
        },
        deleteManualStrengthRecord: async (userId: string, recordId: string) => {
          deletions.push({ userId, recordId });
          if (failDeletion) throw new Error('network');
        },
      },
      '../../services/coach': { openStrengthReview: (recordId: string, userId: string) => coachHandoffs.push({ recordId, userId }) },
      '../../services/request': { ApiError: TestApiError },
      '../../utils/date': dates,
      '../../utils/manual-strength': {
        ...strength,
        getStrengthDraft: () => activeDraft,
        setStrengthDraft: (_userId: string, draft: strength.StrengthDraft) => { activeDraft = draft; },
        clearStrengthDraft: (_userId: string, recordId: string) => {
          if (activeDraft?.id === recordId) activeDraft = undefined;
        },
        newStrengthId: async () => 'mutation',
        newStrengthDraft: async (startedAt: Date) => ({
          id: 'fresh', startedAt: startedAt.toISOString(), revision: 0,
          form: { name: '新训练', note: '', actions: [strength.newAction()] },
        }),
      },
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
  await page.onLoad(options);
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

activeDraft = {
  id: 'deleted-draft', startedAt: savedRecord.started_at, revision: 1,
  form: { name: '原训练', note: '尚未保存', actions: [{
    ...strength.newAction(), name: '深蹲', sets: [{ ...strength.newSet(), quantity: '8' }],
  }] },
};
confirmDelete = async () => ({ confirm: false });
const staleDraft = await loadTrainingPage('../pages/manual-strength/manual-strength.ts', {});
await staleDraft.onSave?.();
assert.equal(staleDraft.data.draft?.id, 'deleted-draft');
assert.equal(staleDraft.data.draft?.form.note, '尚未保存');
assert.equal(staleDraft.data.error, '原训练记录已不存在，无法保存。');
assert.equal(activeDraft.id, 'deleted-draft');
assert.equal(staleDraft.data.canDiscardDraft, true);
await staleDraft.onDiscardDraft?.();
assert.equal(activeDraft.id, 'deleted-draft');

activeDraft.form.actions[0].sets[0].quantity = '0';
const incomplete = await loadTrainingPage('../pages/manual-strength/manual-strength.ts', {});
await incomplete.onSave?.();
assert.deepEqual(saves, ['deleted-draft']);
assert.equal(incomplete.data.canDiscardDraft, true);
confirmDelete = async () => ({ confirm: true });
await incomplete.onDiscardDraft?.();
assert.equal(incomplete.data.draft?.id, 'fresh');
assert.equal(incomplete.data.canDiscardDraft, false);
assert.equal(activeDraft, undefined);
console.log('activity-record-viewer.check: all assertions passed');
