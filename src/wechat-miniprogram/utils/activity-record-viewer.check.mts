import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as dates from './date.ts';
import * as format from './format.ts';

type ActivityResponse = { total: number; activities: Array<{ label_id: string; name: string; date: string; source: string }> };
type PageUnderTest = {
  data: { guest: boolean; monthGroups: Array<{ rows: Array<{ name: string }> }> };
  setData(patch: object): void;
  onLoad(): Promise<void>;
  onShow(): void;
  fetch(): Promise<void>;
};

let page: PageUnderTest | undefined;
let viewerId = 'user-a';
let viewerChanged: (() => void) | undefined;
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
      manualStrengthLiveVersion: () => 0,
      takeManualStrengthEditedNames: () => undefined,
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
    activities: [{ label_id: name, name, date: '2026-11-26T15:00:00+08:00', source: 'manual_strength' }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

await view.onLoad();
await respond('user-a', '账号 A 私人训练');
assert.equal(view.data.monthGroups[0].rows[0].name, '账号 A 私人训练');
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
console.log('activity-record-viewer.check: all assertions passed');
