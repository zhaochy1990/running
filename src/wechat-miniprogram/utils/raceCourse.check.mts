/**
 * raceCourse.ts 自检：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/raceCourse.check.mts`。
 * 覆盖 赛道节判定（无路线无难点 = null）/ 公里段解析（区间与单点、各类破折号、
 * 脏文本）/ 类别前缀剥离与未知前缀兜底 / 站点排序（按起点公里、无里程垫底、
 * 稳定保序）/ 紧凑间距节奏（夹在 GAP 区间、末位余量）/ 短标题剥前导公里段。
 */
import type { RaceItem } from '../services/race-center.ts';
import {
  courseStationTitle,
  parseCourseKm,
  toCourseSection,
} from './raceCourse.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const item = (over: Partial<RaceItem>): RaceItem => ({
  id: 1,
  name: '全程马拉松',
  type: 'Marathon',
  start_time: null,
  entry_fee: null,
  quota: null,
  distance_km: 42.195,
  start_point: null,
  finish_point: null,
  route_description: null,
  total_ascent_m: null,
  course_challenges: null,
  cutoffs: [],
  ...over,
});

// 公里段解析：区间（四种破折号）/ 单点 / 带中文地标 / 解析不出
eq(parseCourseKm('0–16km'), [0, 16], 'range en dash');
eq(parseCourseKm('22—26km'), [22, 26], 'range em dash');
eq(parseCourseKm('18.8-22.6km'), [18.8, 22.6], 'range hyphen + decimals');
eq(parseCourseKm('29~30km'), [29, 30], 'range tilde');
eq(parseCourseKm('17.4km'), [17.4, 17.4], 'single point');
eq(parseCourseKm('0–10km（外滩→南京西路）'), [0, 10], 'range with landmark');
eq(parseCourseKm('起点天安门'), null, 'no number');
eq(parseCourseKm(null), null, 'null text');

// 类别前缀：剥离 + 未知前缀兜底 + 无前缀脏数据
const sec = toCourseSection(
  item({
    route_description: '起点 → 经十路 → 终点',
    total_ascent_m: 290,
    course_challenges: [
      { distance_km: '16–22km', description: '【隧道】玉皇山隧道进洞持续长缓上坡' },
      { distance_km: '0–16km', description: '【坡道】经十路大直道极易无意识冲快' },
      { distance_km: null, description: '【罕见类别】自由文本' },
      { distance_km: '22km', description: '无前缀的脏数据描述' },
      { distance_km: '37km', description: '【折返】丰谷路东端折返' },
    ],
  }),
);
eq(sec === null, false, 'section exists with route+challenges');
eq(sec?.ascent, '290', 'ascent passthrough');
eq(sec?.distanceKm, 42.195, 'distance passthrough');
eq(
  sec?.stations.map((s) => [s.km, s.cat, s.title]),
  [
    ['0–16km', '坡道', '经十路大直道极易无意识冲快'],
    ['16–22km', '隧道', '玉皇山隧道进洞持续长缓上坡'],
    ['22km', '其他', '无前缀的脏数据描述'],
    ['37km', '折返', '丰谷路东端折返'],
    ['全段', '罕见类别', '自由文本'],
  ],
  'stations sorted by start km, no-km last, prefix stripped',
);
eq(sec?.stations[0].key, '1:0', 'station key is section-scoped');
eq(sec?.stations[0].color, '255,159,10', 'known category color');
eq(sec?.stations[2].color, '156,156,157', 'unknown category falls back');

// 紧凑间距：相邻站点间距夹在 [96, 200]，等公里差触顶；画布高留末卡余量
const tops = (sec?.stations ?? []).map((s) => s.top);
eq(tops[0], 0, 'first station at origin');
for (let i = 1; i < tops.length; i++) {
  const gap = tops[i] - tops[i - 1];
  if (gap < 96 || gap > 200) throw new Error(`gap out of range at ${i}: ${gap}`);
}
eq(sec?.plotH, tops[tops.length - 1] + 150, 'plot height = last top + slot');

// 大公里差不超上限、小公里差不低于下限（节奏而非全比例）
const spread = toCourseSection(
  item({
    course_challenges: [
      { distance_km: '0–1km', description: '【拥堵】起点' },
      { distance_km: '40km', description: '【坡道】终点前' },
    ],
  }),
);
eq(
  (spread?.stations[1].top ?? 0) - (spread?.stations[0].top ?? 0),
  200,
  'huge km gap capped at GAP_MAX',
);
const tight = toCourseSection(
  item({
    course_challenges: [
      { distance_km: '10km', description: '【坡道】a' },
      { distance_km: '10km', description: '【拥堵】b' },
    ],
  }),
);
eq(
  (tight?.stations[1].top ?? 0) - (tight?.stations[0].top ?? 0),
  96,
  'zero km gap floors at GAP_MIN',
);

// 短标题：剥前导公里段（不与右上角公里标签重复）、分隔符截断、超长省略
eq(courseStationTitle('22–26km 折返返程再穿隧道为长下坡'), '折返返程再穿隧道为长下坡', 'strip leading range');
eq(courseStationTitle('17.4km 木樨地桥：全场第一坡'), '木樨地桥', 'strip leading point, stop at colon');
eq(courseStationTitle('经十路超长直道开阔（经十路）'), '经十路超长直道开阔', 'stop at paren');
eq(courseStationTitle('这一段特别长特别长特别长特别长特别长特别长'), '这一段特别长特别长特别长特别长特…', 'ellipsis at 16');
eq(courseStationTitle(''), '', 'empty body');

// 无路线且无难点 → null（页面据此隐藏赛道 tab）
eq(toCourseSection(item({})), null, 'no route no challenges');
// 只有路线：节存在，站点为空数组
const routeOnly = toCourseSection(item({ route_description: '起点 → 终点' }));
eq(routeOnly === null, false, 'route-only section exists');
eq(routeOnly?.stations, [], 'route-only has no stations');
eq(routeOnly?.plotH, 150, 'route-only plot is empty canvas');
