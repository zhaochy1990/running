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
  goal: { race_name: '2026上海马拉松' },
  phases: [{ id: 'taper', name: 'taper', start_date: firstWeek, end_date: raceDay }],
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
const modules: Record<string, unknown> = {
  '../../services/plan': {
    getWeeklyPlan: async (_uid: string, week: string) => {
      reads.push(week);
      return { content: active.get(week) };
    },
  },
  '../../utils/date': dates,
};

type PageUnderTest = {
  data: {
    uid: string;
    isPreview: boolean;
    calendarGroups: Array<{ weeks: Array<{ key: string; days: Array<{ summary: string; distLabel: string }>; hasDoc: boolean }> }>;
  };
  setData(patch: object): void;
  applyPlan(plan: unknown): void;
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
});
assert.ok(page);
const view = page;
view.setData = (patch) => { Object.assign(view.data, patch); };
const week = (index: number) => view.data.calendarGroups[0].weeks[index - 1];
const expandRaceWeek = () => view.onWeekExpand({ currentTarget: { dataset: { key: 'w2', week: 2 } } });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

view.setData({ uid: 'test-user', isPreview: true });
view.applyPlan(candidate);
expandRaceWeek();
await settle();
assert.deepEqual(reads, [], '预览的首周和展开周都不能读取生效课表');
assert.equal(week(1).days[0].summary, '预览轻松跑');
assert.equal(week(2).days.length, 1);
assert.equal(week(2).days[0].summary, raceName);
assert.match(week(2).days[0].distLabel, /^42\./);

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
console.log('training plan preview checks passed');
