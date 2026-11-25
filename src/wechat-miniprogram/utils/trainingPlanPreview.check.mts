import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as dates from './date.ts';

const firstWeek = '2026-11-23';
const raceWeek = '2026-11-30';
const raceDay = '2026-12-06';
const raceName = '2026上海马拉松（比赛）';
const oldLongRun = '有氧长跑 25km';
const session = (date: string, summary: string, total_distance_m: number) => ({
  date, summary, total_distance_m, kind: 'run', session_index: 0,
});
const candidate = {
  start_date: firstWeek,
  end_date: raceDay,
  total_weeks: 2,
  goal: { race_name: '2026上海马拉松', distance: 'FM' },
  phases: [{ id: 'taper', name: 'taper', start_date: firstWeek, end_date: raceDay }],
  policy: {
    phases: [{ name: '第四阶段·最终质量期', canonical: 'final_quality', start_week: 1, end_week: 2 }],
    milestones: [{ phase: 'final_quality', signal: '比赛激活', criterion: '按计划完成赛前激活' }],
  },
  weeks: [firstWeek, raceWeek].map((week_start, index) => ({ week_start, week_index: index + 1, phase_id: 'taper' })),
  weekly_docs: [
    { week_index: 1, sessions: [session(firstWeek, '预览轻松跑', 5000)] },
    { week_index: 2, sessions: [session(raceDay, raceName, 42195)] },
  ],
};
const active = new Map([
  [dates.weekFolderName(firstWeek), { sessions: [session(firstWeek, '生效轻松跑', 8000)] }],
  [dates.weekFolderName(raceWeek), { sessions: [session(raceDay, oldLongRun, 24800)] }],
]);
const reads: string[] = [];
let applied = false;
let currentReads = 0;
const publishedRace = '上马比赛（生效周文档）';
const modules: Record<string, unknown> = {
  '../../services/master-plan': {
    getCurrentMasterPlan: async () => {
      currentReads += 1;
      return { content_version: 2, plan_id: 'active-id', revision: 3, plan: candidate };
    },
    applyMasterPlanFromContent: async (token: string, plan: typeof candidate) => {
      assert.equal(token, 'candidate-id');
      assert.equal(plan, candidate);
      applied = true;
      active.set(dates.weekFolderName(raceWeek), { sessions: [session(raceDay, publishedRace, 42195)] });
    },
    markMasterPlanApplied: () => {},
  },
  '../../services/plan': {
    getWeeklyPlan: async (_uid: string, week: string) => {
      reads.push(week);
      return { content: active.get(week) };
    },
  },
  '../../utils/date': dates,
  '../../store/index': { userStore: { getState: () => ({ user: { id: 'test-user' } }) } },
};

type PageUnderTest = {
  data: {
    uid: string;
    isPreview: boolean;
    planSubtitle: string;
    planTotalWeeks: number;
    rhythmBars: Array<{ value: number | string; heightPct: number }>;
    chartPeakLabel: string;
    stage: { milestones: Array<{ criterion: string }> };
    calendarGroups: Array<{ weeks: Array<{ key: string; days: Array<{ summary: string; distLabel: string }>; hasDoc: boolean }> }>;
  };
  _previewPayload: { apply_token: string; content: typeof candidate } | null;
  setData(patch: object): void;
  applyPlan(plan: unknown): void;
  onApplyTap(): Promise<void>;
  onWeekExpand(event: { currentTarget: { dataset: { key: string; week: number } } }): void;
};
let page: PageUnderTest | undefined;
const source = readFileSync(new URL('../pages/training-plan/training-plan.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
runInNewContext(js, {
  exports: {},
  console,
  require: (path: string) => modules[path] ?? {},
  Page: (definition: PageUnderTest) => { page = definition; },
  wx: {
    showModal: (options: { success(result: { confirm: boolean }): void }) => options.success({ confirm: true }),
    showLoading: () => {},
    hideLoading: () => {},
    showToast: () => {},
  },
});
assert.ok(page);
const view = page;
view.setData = (patch) => { Object.assign(view.data, patch); };
const week = (index: number) => view.data.calendarGroups[0].weeks[index - 1];
const expandRaceWeek = () => view.onWeekExpand({ currentTarget: { dataset: { key: 'w2', week: 2 } } });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

view.setData({ uid: 'test-user', isPreview: true });
view.applyPlan(candidate);
assert.equal(view.data.planTotalWeeks, 2);
assert.equal(view.data.rhythmBars.length, 2);
assert.equal(view.data.chartPeakLabel, '—');
assert.equal(view.data.rhythmBars[0]?.value, '—');
assert.equal(view.data.stage.milestones[0]?.criterion, '按计划完成赛前激活');
assert.match(view.data.planSubtitle, /^全程马拉松/);
const template = readFileSync(new URL('../pages/training-plan/training-plan.wxml', import.meta.url), 'utf8');
assert.match(template, /\{\{planTotalWeeks\}\}周训练节奏/);
expandRaceWeek();
await settle();
assert.deepEqual(reads, [], '预览的首周和展开周都不能读取生效课表');
assert.equal(week(1).days[0].summary, '预览轻松跑');
assert.equal(week(2).days.length, 1);
assert.equal(week(2).days[0].summary, raceName);
assert.match(week(2).days[0].distLabel, /^42\./);

view.applyPlan({
  ...candidate,
  goal: { race_name: '半程测试赛', distance: 'HM' },
  total_weeks: 1,
  weeks: [{ ...candidate.weeks[0], target_weekly_km_high: 0 }],
});
assert.equal(view.data.planTotalWeeks, 1);
assert.equal(view.data.rhythmBars.length, 1);
assert.equal(view.data.chartPeakLabel, '0 km');
assert.equal(view.data.rhythmBars[0]?.value, 0);
assert.match(view.data.planSubtitle, /^半程马拉松/);

view.applyPlan({ ...candidate, weekly_docs: candidate.weekly_docs.slice(0, 1) });
expandRaceWeek();
await settle();
assert.equal(week(2).hasDoc, false);
assert.equal(week(2).days.length, 0);
assert.deepEqual(reads, [], '候选缺周文档时保留骨架');

view.setData({ isPreview: false });
view.applyPlan(candidate);
expandRaceWeek();
await settle();
assert.deepEqual(reads, [dates.weekFolderName(firstWeek), dates.weekFolderName(raceWeek)]);
assert.equal(week(2).days[0].summary, oldLongRun, '生效页面使用周文档投影');

reads.length = 0;
view.setData({ isPreview: true });
view._previewPayload = { apply_token: 'candidate-id', content: candidate };
view.applyPlan(candidate);
await view.onApplyTap();
await settle();
assert.equal(applied, true);
assert.equal(currentReads, 2, '启用前预检并在启用后重拉生效计划');
assert.equal(view.data.isPreview, false);
expandRaceWeek();
await settle();
assert.deepEqual(reads, [dates.weekFolderName(firstWeek), dates.weekFolderName(raceWeek)]);
assert.equal(week(2).days[0].summary, publishedRace, '启用后读取持久化周课表');
console.log('training plan preview checks passed');
