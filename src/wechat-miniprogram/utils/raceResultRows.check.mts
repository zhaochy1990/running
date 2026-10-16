/**
 * raceResultRows.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/raceResultRows.check.mts`。
 * 覆盖成绩行显示名解析链（race_name → display_name → name → 空串兜底）。
 */
import type { RaceItem } from '../services/races.ts';
import { applyRaceRename, raceDisplayName } from './raceResultRows.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const blank = { race_name: null, display_name: null, name: null };

eq(raceDisplayName({ ...blank, race_name: '厦门马拉松' }), '厦门马拉松', 'official name wins');
eq(raceDisplayName({ ...blank, display_name: '我的首马' }), '我的首马', 'manual name second');
eq(raceDisplayName({ ...blank, name: '下午跑步' }), '下午跑步', 'activity name third');
eq(raceDisplayName(blank), '', 'all empty → caller falls back to band label');
eq(raceDisplayName({ race_name: 'A', display_name: 'B', name: 'C' }), 'A', 'chain order');
eq(raceDisplayName({ race_name: '', display_name: 'B', name: 'C' }), 'B', 'empty string skipped');

// rename 成功后就地刷新内存行（devops#561）：下次长按 modal 回显新名；空串清除为 null
const rawRace = {
  label_id: 'l1',
  race_name: null,
  display_name: '旧手输名',
  name: '下午跑步',
  distance_band: 'half_marathon',
} as RaceItem;
eq(applyRaceRename(rawRace, '新手输名').display_name, '新手输名', 'rename syncs in-memory display_name');
eq(applyRaceRename(rawRace, '').display_name, null, 'empty name clears display_name');
eq(applyRaceRename(rawRace, '新手输名').name, '下午跑步', 'rename keeps other fields');

console.log('raceResultRows check ok');
