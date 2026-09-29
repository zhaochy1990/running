/**
 * racePlanRows.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/racePlanRows.check.mts`。
 * 覆盖 状态徽章文案 / 状态条 chips（三态流转与 lost 旁路）/ 报名项目缩写 /
 * 下架占位（含 race 行被删的纯占位卡）/ 比赛日排序，不依赖小程序运行时
 * （services 只做 type-only 导入，剥离后无副作用）。
 */
import type { RacePlan } from '../services/race-plans.ts';
import { toPlanCard, toPlanCards } from './racePlanRows.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const DEF_RACE: RacePlan['race'] = {
  id: 1,
  name: 'Hangzhou Marathon',
  name_cn: '2026杭州马拉松',
  race_date: '2026-11-01',
  province: '浙江省',
  city: '杭州市',
  label: 'A',
  wa_label: 'Gold',
};

const plan = (over: Partial<RacePlan>): RacePlan => ({
  race_id: 1,
  item_type: 'Marathon',
  state: 'registered',
  hotel: false,
  transit: false,
  race: DEF_RACE,
  offboarded: false,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  ...over,
});

// 状态全称：四态徽章文案（#385 定稿词表，经 toPlanCard 断言同一条代码路径）
eq(toPlanCard(plan({ state: 'registered' })).stateLabel, '已报名 · 等抽签', 'label registered');
eq(toPlanCard(plan({ state: 'won' })).stateLabel, '已中签', 'label won');
eq(toPlanCard(plan({ state: 'lost' })).stateLabel, '未中签', 'label lost');
eq(toPlanCard(plan({ state: 'confirmed' })).stateLabel, '确认参赛', 'label confirmed');

// 状态条 chips：三态短名（registered 去掉「· 等抽签」），当前态点亮
const reg = toPlanCard(plan({ state: 'registered' }));
eq(reg.steps.map((s) => s.label), ['已报名', '已中签', '确认参赛'], 'flow short labels');
eq(reg.steps.map((s) => s.on), [true, false, false], 'registered on first chip');
eq(toPlanCard(plan({ state: 'won' })).steps.map((s) => s.on), [false, true, false], 'won on second chip');
eq(toPlanCard(plan({ state: 'confirmed' })).steps.map((s) => s.on), [false, false, true], 'confirmed on third chip');
const lost = toPlanCard(plan({ state: 'lost' }));
eq(lost.steps.map((s) => s.on), [false, false, false], 'lost lights no chip');
eq(lost.lost, true, 'lost card carries CTA row');
eq(reg.lost, false, 'registered card has no CTA row');

// 卡头：中文名优先、报名项目缩写、日期含星期、token 原文保留（upsert 回写用）
eq(reg.name, '2026杭州马拉松', 'name_cn preferred');
eq(reg.itemLabel, '全马', 'item marathon abbr');
eq(reg.itemToken, 'Marathon', 'raw token kept');
eq(reg.dateLabel, '2026/11/01 周日', 'date with weekday');
eq(reg.city, '杭州市', 'city');
eq(toPlanCard(plan({ item_type: 'HalfMarathon' })).itemLabel, '半马', 'item half abbr');
eq(toPlanCard(plan({ item_type: 'Other' })).itemLabel, '—', 'item unknown dash');
eq(toPlanCard(plan({ race: { ...DEF_RACE, name_cn: null } })).name, 'Hangzhou Marathon', 'fallback to english name');

// 下架占位：offboarded 透传；race 行被物理删除时回落占位名、无日期城市
const off = toPlanCard(plan({ offboarded: true }));
eq(off.offboarded, true, 'offboarded flag passed through');
eq(off.name, '2026杭州马拉松', 'offboarded keeps name');
const gone = toPlanCard(plan({ offboarded: true, race: null }));
eq(gone.name, '已下架赛事', 'deleted race falls back to placeholder name');
eq(gone.dateLabel, '', 'deleted race has no date');
eq(gone.city, '', 'deleted race has no city');

// 排序：比赛日升序，同日按 race_id；无日期（race=null）沉底
const unordered = toPlanCards([
  plan({ race_id: 30, race: { ...DEF_RACE, race_date: '2026-12-06' } }),
  plan({ race_id: 10 }),
  plan({ race_id: 20, offboarded: true, race: null }),
  plan({ race_id: 40, race: { ...DEF_RACE, race_date: '2026-10-18' } }),
]);
eq(unordered.map((c) => c.raceId), [40, 10, 30, 20], 'sorted by race_date, dateless sink');

console.log('racePlanRows check passed');
