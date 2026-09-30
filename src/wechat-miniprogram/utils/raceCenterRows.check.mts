/**
 * raceCenterRows.ts 自检：`node utils/raceCenterRows.check.mts`。
 * 覆盖徽章全称映射 / 项目缩写 / 客户端筛选 / 月份分组 / 城市选项，
 * 不依赖小程序运行时（services 只做 type-only 导入，剥离后无副作用）。
 */
import type { RaceCalendarRace } from '../services/race-center.ts';
import {
  filterRaces,
  groupByMonth,
  toRowView,
  typeAbbr,
} from './raceCenterRows.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const race = (over: Partial<RaceCalendarRace>): RaceCalendarRace => ({
  id: 1,
  name: 'Xiamen Marathon',
  name_cn: null,
  race_date: '2026-01-04',
  province: '福建省',
  city: '厦门市',
  label: null,
  wa_label: null,
  race_types: ['Marathon'],
  favorited: false,
  ...over,
});

// 项目缩写：全/半马中文，{n}Km 压成 {n}K，Other/Unknown/杂值不显示
eq(typeAbbr('Marathon'), '全马', 'abbr marathon');
eq(typeAbbr('HalfMarathon'), '半马', 'abbr half');
eq(typeAbbr('10Km'), '10K', 'abbr 10km');
eq(typeAbbr('5.2Km'), '5.2K', 'abbr 5.2km');
eq(typeAbbr('Other'), '', 'abbr other hidden');
eq(typeAbbr('Unknown'), '', 'abbr unknown hidden');
eq(typeAbbr('weird'), '', 'abbr junk hidden');

// 双徽章全称：已知的田协/WA 取值给全称，未知取值与 null 都隐藏
const dual = toRowView(race({ label: 'A', wa_label: 'Platinum' }));
eq([dual.cnBadge, dual.waBadge], ['中国田协A类赛事', '世界田联白金标'], 'badges full names');
eq(toRowView(race({ label: 'C（属地办赛）' })).cnBadge, '中国田协C类（属地办赛）', 'badge cn C local');
eq(toRowView(race({ label: '系列赛' })).cnBadge, '中国田协系列赛', 'badge cn series');
eq(toRowView(race({ wa_label: 'Gold' })).waBadge, '世界田联金标', 'badge wa gold');
eq(toRowView(race({ label: 'S级', wa_label: 'Diamond' })).cnBadge, '', 'badge unknown hidden');
eq(toRowView(race()).cnBadge, '', 'badge null hidden');

// 行视图：日期 MM/DD + 周几（2026-01-04 是周日）、中文名优先、项目缩写串
const r1 = toRowView(race({ name_cn: '2026厦门马拉松', race_types: ['Marathon', 'HalfMarathon', '10Km'] }));
eq(r1.dateLabel, '01/04', 'date MM/DD');
eq(r1.weekday, '周日', 'weekday label');
eq(r1.name, '2026厦门马拉松', 'name_cn preferred');
eq(r1.typesLabel, '全马/半马/10K', 'types joined');
eq(toRowView(race({ race_types: ['Unknown'] })).typesLabel, '—', 'types empty dash');
eq(toRowView(race({ city: null })).city, '—', 'city null dash');

// 筛选：type 走 race_types 数组、city 原文精确、收藏视图只留 favorited
const pool = [
  race({ id: 1, race_types: ['Marathon'], city: '厦门市', favorited: true }),
  race({ id: 2, race_types: ['HalfMarathon', '10Km'], city: '杭州市', favorited: false }),
  race({ id: 3, race_types: ['10Km'], city: null, favorited: true, race_date: '2026-03-01' }),
];
eq(filterRaces(pool, { type: '', favoritesOnly: false }).map((r) => r.id), [1, 2, 3], 'filter none');
eq(filterRaces(pool, { type: '10Km', favoritesOnly: false }).map((r) => r.id), [2, 3], 'filter type array');
eq(filterRaces(pool, { type: '', favoritesOnly: true }).map((r) => r.id), [1, 3], 'filter favorites');

// 分组：按月升序、组内按日期、key 供 wx:key、label 去前导零
const grouped = groupByMonth([
  race({ id: 9, race_date: '2026-11-01' }),
  race({ id: 2, race_date: '2026-10-06' }),
  race({ id: 1, race_date: '2026-10-02' }),
  race({ id: 5, race_date: '2025-12-28' }),
]);
eq(grouped.map((g) => g.label), ['12月', '10月', '11月'], 'group labels no leading zero');
eq(grouped.map((g) => g.key), ['2025-12', '2026-10', '2026-11'], 'group keys ascending');
eq(grouped.map((g) => g.rows.map((r) => r.id)), [[5], [1, 2], [9]], 'group rows by date');

// 城市选项：去重、不含 null；顺序只保证稳定（拼音排序依赖 ICU，不硬断言）

console.log('raceCenterRows check passed');
