/**
 * raceDetailRows.ts 自检：
 * `node --import ./utils/ts-resolve-hooks.mjs utils/raceDetailRows.check.mts`。
 * 覆盖 三宫格/时间轴（完成态按注入 today）/ 概要键值行 / 报名渠道复制规则 /
 * 项目节（报名费分转元、赛道·关门待补）/ 出行视图 / 报名选择器词汇与 chips，
 * 不依赖小程序运行时（services 只做 type-only 导入，剥离后无副作用）。
 */
import type {
  RaceCityContent,
  RaceDetail,
  RaceItem,
} from '../services/race-center.ts';
import {
  daysUntil,
  firstStartTime,
  itemChips,
  planButtonLabel,
  toDetailView,
} from './raceDetailRows.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

const TODAY = '2026-09-29';

const item = (over: Partial<RaceItem>): RaceItem => ({
  id: 1,
  name: '全程马拉松',
  type: 'Marathon',
  start_time: '07:30',
  entry_fee: 15000,
  quota: 20000,
  distance_km: 42.195,
  start_point: { name: '黄龙体育中心' },
  finish_point: { name: '奥体中心' },
  route_description: null,
  cutoffs: [],
  ...over,
});

const detail = (over: Partial<RaceDetail>): RaceDetail => ({
  id: 43,
  name: 'Hangzhou Marathon',
  name_cn: '2026杭州马拉松',
  race_date: '2026-11-01',
  province: '浙江省',
  city: '杭州市',
  label: 'A',
  wa_label: 'Gold',
  race_types: ['Marathon', 'HalfMarathon'],
  favorited: false,
  signup_timeline: {
    start_at: '2026-06-23',
    deadline: '2026-07-15',
    lottery: true,
    lottery_result_at: null,
    payment_deadline: '2026-07-25',
  },
  signup_channels: [
    { name: '官网', type: '官网', url: 'https://hm.example.cn', url_type: 'web' },
    { name: '杭州马拉松公众号', type: '公众号', url: null, url_type: '' },
    { name: '浙体育', type: '合作App', url: 'https://qr.example/x.png', url_type: 'qrcode' },
  ],
  packet_pickup: [],
  items: [
    item({}),
    item({
      id: 2,
      name: '半程马拉松',
      type: 'HalfMarathon',
      start_time: '07:35',
      entry_fee: 12000,
      quota: 12000,
      distance_km: 21.0975,
    }),
  ],
  city_content: null,
  ...over,
});

// 距开赛天数：跨月/跨年/当天/已结束
eq(daysUntil('2026-09-30', TODAY), 1, 'days +1');
eq(daysUntil('2026-11-01', TODAY), 33, 'days across month');
eq(daysUntil('2027-01-01', TODAY), 94, 'days across year');
eq(daysUntil(TODAY, TODAY), 0, 'days today');
eq(daysUntil('2026-09-28', TODAY), -1, 'days past');

// 最早发枪时间：字典序即 HH:MM 时间序；空 = ''
eq(firstStartTime(detail({}).items), '07:30', 'earliest start time');
eq(firstStartTime([item({ start_time: null }), item({ id: 2, start_time: '08:00' })]), '08:00', 'skip null start');
eq(firstStartTime([]), '', 'no start time');

// 三宫格 + 时间轴：天后开赛 / 比赛日带发枪 / 抽签制式；完成态按注入 today
const v = toDetailView(detail({}), TODAY);
eq(v.head.name, '2026杭州马拉松', 'head name_cn preferred');
eq(v.head.grid, [
  { value: '33', label: '天后开赛', lead: true },
  { value: '11/01', label: '比赛日 07:30', lead: false },
  { value: '抽签', label: '报名制式', lead: false },
], 'head grid');
eq(v.head.timeline, [
  { key: 'start', label: '报名开始', date: '6/23', done: true },
  { key: 'deadline', label: '报名截止', date: '7/15', done: true },
  { key: 'draw', label: '出签·缴费', date: '7/25', done: true },
  { key: 'race', label: '开赛', date: '11/1', done: false },
], 'timeline done by today');

// 时间轴边界：非抽签且无缴费截止收成三步（无信息的「待公布」死格不渲染）；
// 抽签制恒四步；比赛日当天 done；无 signup_timeline = 空数组（整条隐藏）
const noLottery = toDetailView(
  detail({
    signup_timeline: {
      start_at: '2026-09-29',
      deadline: '2026-10-20',
      lottery: false,
      lottery_result_at: null,
      payment_deadline: null,
    },
  }),
  TODAY,
);
eq(noLottery.head.timeline.map((s) => [s.label, s.date, s.done]), [
  ['报名开始', '9/29', true],
  ['报名截止', '10/20', false],
  ['开赛', '11/1', false],
], 'no-lottery timeline collapses to 3 steps');
const noLotteryWithPay = toDetailView(
  detail({
    signup_timeline: {
      start_at: '2026-09-01',
      deadline: '2026-09-20',
      lottery: false,
      lottery_result_at: null,
      payment_deadline: '2026-09-25',
    },
  }),
  TODAY,
);
eq(noLotteryWithPay.head.timeline.map((s) => [s.label, s.date]), [
  ['报名开始', '9/1'],
  ['报名截止', '9/20'],
  ['缴费截止', '9/25'],
  ['开赛', '11/1'],
], 'no-lottery with payment keeps 4 steps');
eq(toDetailView(detail({ signup_timeline: null }), TODAY).head.timeline, [], 'timeline hidden');
eq(toDetailView(detail({ signup_timeline: null }), TODAY).head.grid[2], {
  value: '待定',
  label: '报名制式',
  lead: false,
}, 'format unknown without timeline');
eq(toDetailView(detail({ race_date: TODAY }), TODAY).head.grid[0], {
  value: '今天',
  label: '开赛',
  lead: false,
}, 'grid race today');
eq(toDetailView(detail({ race_date: '2026-01-04' }), TODAY).head.grid[0], {
  value: '已结束',
  label: '',
  lead: false,
}, 'grid race past no lead color');

// 概要键值行：比赛日+周几、地点带首起点、认证全称、规模求和、空项目占位
eq(v.summary, [
  { k: '比赛日', v: '2026-11-01 周日' },
  { k: '起跑时间', v: '07:30' },
  { k: '地点', v: '浙江省杭州市 · 黄龙体育中心' },
  { k: '认证', v: '中国田协A类赛事 · 世界田联金标' },
  { k: '项目', v: '全程马拉松 / 半程马拉松' },
  { k: '规模', v: '32,000 人' },
], 'summary rows');
const bare = toDetailView(
  detail({ label: null, wa_label: null, province: null, city: null, items: [] }),
  TODAY,
);
eq(
  bare.summary.filter((r) => ['起跑时间', '地点', '认证', '项目', '规模'].includes(r.k)),
  [
    { k: '起跑时间', v: '待定' },
    { k: '地点', v: '待定' },
    { k: '认证', v: '—' },
    { k: '项目', v: '—' },
    { k: '规模', v: '待定' },
  ],
  'summary empty fallbacks',
);

// 报名渠道：web 且有 url 才给复制链接；qrcode/无 url 只展示；key 供 wx:key（渠道名可重）
eq(v.channels, [
  { key: '0', name: '官网', type: '官网', copyUrl: 'https://hm.example.cn' },
  { key: '1', name: '杭州马拉松公众号', type: '公众号', copyUrl: '' },
  { key: '2', name: '浙体育', type: '合作App', copyUrl: '' },
], 'channel rows copy rules');

// 项目节：报名费分→元（整/角分）、赛道待补
eq(v.items[0].rows, [
  { k: '距离', v: '42.195 km' },
  { k: '名额', v: '20,000 人' },
  { k: '起终点', v: '黄龙体育中心 → 奥体中心' },
  { k: '发枪', v: '07:30' },
  { k: '报名费', v: '¥150' },
], 'item rows');
eq(v.items[0].route, '', 'route empty');
const rich = toDetailView(
  detail({
    items: [
      item({
        entry_fee: 12550,
        quota: null,
        distance_km: null,
        start_point: null,
        route_description: '黄龙路→曙光路→杨公堤……→奥体中心',
      }),
    ],
  }),
  TODAY,
);
eq(rich.items[0].rows, [
  { k: '距离', v: '待定' },
  { k: '名额', v: '待定' },
  { k: '起终点', v: '奥体中心' },
  { k: '发枪', v: '07:30' },
  { k: '报名费', v: '¥125.50' },
], 'item partial fallbacks');
eq(rich.items[0].route, '黄龙路→曙光路→杨公堤……→奥体中心', 'route text');

// 出行：领物/城市空态字段；有城市内容时段落过滤空章、标题预拼接、景点透出
eq(v.trip, { pickups: [], city: null }, 'trip empty');
const trip = toDetailView(
  detail({
    packet_pickup: [
      { time: '10/30 09:00-20:00', location: '黄龙体育中心' },
      { time: '10/30 09:00-20:00', location: '奥体中心' },
    ],
    city_content: {
      city: '杭州市',
      intro: { overview: '人间天堂。', culture: '', food: '西湖醋鱼。', history: '' },
      attractions: [{ name: '西湖', description: '城市名片' }],
    },
  }),
  TODAY,
);
eq(trip.trip.pickups, [
  { key: '0', time: '10/30 09:00-20:00', location: '黄龙体育中心' },
  { key: '1', time: '10/30 09:00-20:00', location: '奥体中心' },
], 'pickup rows keyed (same time distinct rows)');
eq(trip.trip.city?.title, '城市 · 杭州市', 'city title prebuilt');
eq(trip.trip.city?.paragraphs, [
  { k: '概览', v: '人间天堂。' },
  { k: '美食', v: '西湖醋鱼。' },
], 'city paragraphs skip empty');
eq(trip.trip.city?.attractions, [{ name: '西湖', description: '城市名片' }], 'attractions');

// 报名选择器：chips 去重与回落、按钮文案四态
eq(itemChips(detail({}).items), [
  { token: 'Marathon', label: '全马' },
  { token: 'HalfMarathon', label: '半马' },
], 'chips abbr');
eq(
  itemChips([item({ type: 'Other', name: '欢乐跑' }), item({ id: 2, type: 'Other', name: '亲子跑' })]),
  [{ token: 'Other', label: '欢乐跑' }],
  'chips dedupe fallback name',
);
eq(planButtonLabel('Marathon', 'none'), '未报名', 'button none');
eq(planButtonLabel('Marathon', 'registered'), '全马 · 已报名（等抽签）', 'button registered');
eq(planButtonLabel('HalfMarathon', 'won'), '半马 · 已中签', 'button won');
eq(planButtonLabel('10Km', 'confirmed'), '10K · 确认参赛', 'button km chip');
eq(planButtonLabel('Marathon', 'lost'), '全马 · 未中签', 'button lost');

// 仅基础字段赛事（#395 e2e 回归）：后端契约「absent-when-empty as null」——
// signup_channels / packet_pickup / cutoffs 为 null 时 toDetailView 不得抛
// （曾因按非空数组 .map 白屏），各段渲染为空集合。
const noContentRace = toDetailView(
  detail({
    signup_timeline: null,
    signup_channels: null,
    packet_pickup: null,
    items: [
      item({
        cutoffs: null as unknown as RaceItem['cutoffs'],
        start_time: null,
        entry_fee: null,
        quota: null,
        distance_km: null,
        start_point: null,
        finish_point: null,
      }),
    ],
  }),
  TODAY,
);
eq(noContentRace.channels, [], 'bare race: channels null → empty rows');
eq(noContentRace.trip.pickups, [], 'bare race: pickups null → empty list');
eq(noContentRace.head.timeline, [], 'bare race: no timeline');

// 城市内容有 intro 无 attractions：attractions null → 空列表
const introOnly = toDetailView(
  detail({
    city_content: {
      city: '杭州市',
      intro: { overview: 'o', culture: '', food: 'f', history: '' },
      attractions: null as unknown as RaceCityContent['attractions'],
    },
  }),
  TODAY,
);
eq(introOnly.trip.city?.attractions, [], 'city attractions null → empty');

console.log('raceDetailRows check passed');
