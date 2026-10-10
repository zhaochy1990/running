/**
 * myRaceRows.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/myRaceRows.check.mts`。
 * 覆盖 类型（距离）徽章（无距离降级 / 小数距离）/ 两态状态 chips 与切换补丁 /
 * 已结束派生（灰态标签、隐藏 chips 与倒计时）/ meta 行缺项省略 / 混排保序与 key 前缀，
 * 不依赖小程序运行时（services 只做 type-only 导入，剥离后无副作用）。
 */
import type { CustomRace, MyRaceItem } from '../services/custom-races.ts';
import { customStatePatch, toCustomCard, toMyRaceRows } from './myRaceRows.ts';
import { toPlanCard } from './racePlanRows.ts';
import { epochToShanghaiYmd, shanghaiToday, shanghaiYmdToEpoch } from './date.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const DAY_MS = 86400000;
const ymdOffset = (days: number): string =>
  epochToShanghaiYmd(shanghaiYmdToEpoch(shanghaiToday()) + days * DAY_MS);

const race = (over: Partial<CustomRace>): CustomRace => ({
  id: 7,
  name: '柴古唐斯括苍山越野赛',
  race_date: ymdOffset(30),
  item_type: 'Trail',
  distance_km: 50,
  ascent_m: 3200,
  city: '台州 · 临海',
  website: '',
  note: '带上冲锋衣',
  state: 'want',
  hotel: false,
  transit: false,
  done: false,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  ...over,
});

// 类型（距离）徽章：无距离只显类型；整数不加小数位；小数保留一位
eq(toCustomCard(race({ distance_km: 50 })).badgeLabel, '越野跑 50K', 'badge trail 50K');
eq(toCustomCard(race({ item_type: 'HalfMarathon', distance_km: 21.1 })).badgeLabel, '半马 21.1K', 'badge half 21.1K');
eq(toCustomCard(race({ distance_km: null })).badgeLabel, '越野跑', 'badge no distance');
eq(toCustomCard(race({ item_type: 'Other', distance_km: null })).badgeLabel, '其他', 'badge other');
eq(toCustomCard(race({ item_type: 'Mystery' })).badgeLabel, 'Mystery 50K', 'badge unknown token passthrough');

// 两态状态：标签、chips 点亮、切换补丁
eq(toCustomCard(race({ state: 'want' })).stateLabel, '想跑', 'label want');
eq(toCustomCard(race({ state: 'registered' })).stateLabel, '已报名', 'label registered');
eq(
  toCustomCard(race({ state: 'registered' })).steps.map((s) => [s.label, s.on]),
  [
    ['想跑', false],
    ['已报名', true],
  ],
  'chips registered',
);
eq(
  customStatePatch('want').steps.map((s) => s.on),
  [true, false],
  'patch chips want',
);

// 已结束派生（后端下发的 done 标志，race_date 已过）：灰态标签、chips 与倒计时清空
const past = toCustomCard(race({ race_date: ymdOffset(-1), done: true }));
eq(past.stateLabel, '已结束', 'past label');
eq(past.steps, [], 'past chips hidden');
eq(past.countdown, '', 'past countdown hidden');

// 倒计时：未来 N 天 / 当天开赛
eq(toCustomCard(race({ race_date: ymdOffset(10) })).countdown, '距离比赛还有 10 天', 'countdown 10d');
eq(toCustomCard(race({ race_date: shanghaiToday() })).countdown, '今天开赛', 'countdown today');

// meta 行：日期 · 城市 · 爬升 D+，缺项省略
const full = toCustomCard(race({}));
eq(full.metaLabel.includes(' · 台州 · 临海'), true, 'meta city');
eq(full.metaLabel.includes(' · 爬升 D+3200m'), true, 'meta ascent');
eq(
  toCustomCard(race({ city: '', ascent_m: null })).metaLabel.split(' · ').length,
  1,
  'meta omits missing city/ascent',
);

// 混排：official 走 toPlanCard（name 取赛事投影），custom 走 toCustomCard；key 前缀防撞；保序
const officialItem: MyRaceItem = {
  source: 'official',
  plan: {
    race_id: 7,
    item_type: 'Marathon',
    state: 'registered',
    hotel: false,
    transit: false,
    race: {
      id: 7,
      name: 'Hangzhou Marathon',
      name_cn: '2026杭州马拉松',
      race_date: ymdOffset(60),
      province: null,
      city: '杭州市',
      label: null,
      wa_label: null,
    },
    offboarded: false,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
  },
};
const rows = toMyRaceRows([officialItem, { source: 'custom', race: race({ id: 7 }) }]);
eq(rows.length, 2, 'rows mixed');
eq(rows[0].key, 'o-7', 'official key prefix');
eq(rows[1].key, 'c-7', 'custom key prefix');
eq(rows[0].kind === 'official' && rows[0].plan.name, '2026杭州马拉松', 'official reuses toPlanCard');
eq(rows[1].kind === 'custom' && rows[1].custom.name, '柴古唐斯括苍山越野赛', 'custom card name');

// 残缺项跳过：custom 无载荷 / 未知 source
eq(toMyRaceRows([{ source: 'custom' }]).length, 0, 'custom without payload skipped');

// 备注：空串隐藏
eq(toCustomCard(race({ note: '' })).note, '', 'note empty');

console.log('myRaceRows.check: all assertions passed');
