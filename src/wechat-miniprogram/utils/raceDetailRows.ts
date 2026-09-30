// 赛事详情页的纯视图模型 —— 不依赖小程序运行时，
// 配套 utils/raceDetailRows.check.mts 自检
// （`node --import ./utils/ts-resolve-hooks.mjs utils/raceDetailRows.check.mts`）。
// 页面（pages/race-center/detail）负责请求与交互，这里只做
// 数据 → 头区 / 难度 / 项目 / 出行 视图的确定性变换。
// 版式按 #385 定稿：头区（名称+星标+双徽章 → 三宫格 → 报名时间轴 → 报名按钮）
// + 难度/项目/出行 三 tab；比赛策略卡归 v2（#386），本期不上。

import type { RaceDetail, RaceItem } from '../services/race-center';
import type { RacePlanState } from '../services/race-plans';
import { cnBadgeOf, waBadgeOf, typeAbbr } from './raceCenterRows';
import { shanghaiWeekdayLabel, shanghaiYmdToEpoch } from './date';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 距开赛天数：比赛日当天 = 0，已结束为负。today/raceDate 均为上海 YYYY-MM-DD。 */
export function daysUntil(raceDate: string, today: string): number {
  return Math.round((shanghaiYmdToEpoch(raceDate) - shanghaiYmdToEpoch(today)) / DAY_MS);
}

/** YYYY-MM-DD → 'M/D'（去前导零，时间轴口径）。非法/空输入 → '待公布'。 */
function mdLabel(ymd: string | null | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '待公布';
  return `${parseInt(ymd.slice(5, 7), 10)}/${parseInt(ymd.slice(8, 10), 10)}`;
}

/** 三宫格一格（天后开赛 / 比赛日 / 报名制式）；lead=主强调色（仅未开赛的倒计时）。 */
export interface RaceHeadCell {
  value: string;
  label: string;
  lead: boolean;
}

/** 报名时间轴一步：date '待公布'=未录入；done 按当前日期计算（#393）。 */
export interface RaceTimelineStep {
  key: string;
  date: string;
  label: string;
  done: boolean;
}

/** 头区渲染模型：timeline 为空数组 = 整条隐藏（未录入 signup_timeline）。 */
export interface RaceDetailHead {
  name: string;
  cnBadge: string;
  waBadge: string;
  grid: RaceHeadCell[];
  timeline: RaceTimelineStep[];
}

/** 概要/项目共用的键值行。 */
export interface RaceKvRow {
  k: string;
  v: string;
}

/** 报名渠道行：copyUrl 非空才有「复制链接」，否则按站内渠道标注形态。key 供 wx:key（渠道名可重）。 */
export interface RaceChannelRow {
  key: string;
  name: string;
  type: string;
  copyUrl: string;
}

/** 项目一节：entry 行 + 赛道（空 = 「待补」）。关门时间不再透出（人工验收反馈）。 */
export interface RaceItemSection {
  id: number;
  title: string;
  rows: RaceKvRow[];
  route: string;
}

/** 出行 tab：领物 + 城市介绍（null = 城市未维护，页脚空态「待发布」）。key 供 wx:key（时段可重）。 */
export interface RaceTripView {
  pickups: Array<{ key: string; time: string; location: string }>;
  city: {
    /** 卡片标题预拼接（'城市 · 杭州'）：wxml 不做数据拼接 */
    title: string;
    paragraphs: RaceKvRow[];
    attractions: Array<{ name: string; description: string }>;
  } | null;
}

/** 详情页整体视图模型。 */
export interface RaceDetailView {
  head: RaceDetailHead;
  summary: RaceKvRow[];
  channels: RaceChannelRow[];
  items: RaceItemSection[];
  trip: RaceTripView;
}

/** 报名费分 → 元标签；null/非正数 = 待定。 */
function feeLabel(fen: number | null): string {
  if (fen == null || fen <= 0) return '待定';
  const yuan = fen / 100;
  return Number.isInteger(yuan) ? `¥${yuan}` : `¥${yuan.toFixed(2)}`;
}

/** 各项目发枪时间里最早的一个（HH:MM 字典序即时间序）；没有 = ''。 */
export function firstStartTime(items: RaceItem[]): string {
  const times = items.map((it) => it.start_time).filter((t): t is string => !!t);
  return times.length ? times.sort()[0] : '';
}

function headGrid(detail: RaceDetail, today: string): RaceHeadCell[] {
  const days = daysUntil(detail.race_date, today);
  const countCell: RaceHeadCell =
    days > 0
      ? { value: String(days), label: '天后开赛', lead: true }
      : days === 0
        ? { value: '今天', label: '开赛', lead: false }
        : { value: '已结束', label: '', lead: false };
  const start = firstStartTime(detail.items);
  const dayCell: RaceHeadCell = {
    value: detail.race_date.slice(5).replace('-', '/'),
    label: start ? `比赛日 ${start}` : '比赛日',
    lead: false,
  };
  const t = detail.signup_timeline;
  const format = t ? (t.lottery ? '抽签' : '先到先得') : '待定';
  return [countCell, dayCell, { value: format, label: '报名制式', lead: false }];
}

/**
 * 报名时间轴：报名开始 → 截止 → 出签·缴费 → 开赛，完成态按 today 判定。
 * 非抽签且无缴费截止时收成三步——后端契约里无抽签赛 PaymentDeadline 常为空
 * （报名即缴费），一格恒「待公布」没有信息量。
 */
function timelineSteps(detail: RaceDetail, today: string): RaceTimelineStep[] {
  const t = detail.signup_timeline;
  if (!t) return [];
  const drawAt = t.lottery_result_at || t.payment_deadline;
  const defs: Array<{ key: string; label: string; date: string | null | undefined }> = [
    { key: 'start', label: '报名开始', date: t.start_at },
    { key: 'deadline', label: '报名截止', date: t.deadline },
    { key: 'draw', label: t.lottery ? '出签·缴费' : '缴费截止', date: drawAt },
    { key: 'race', label: '开赛', date: detail.race_date },
  ];
  return defs
    .filter((d) => d.key !== 'draw' || t.lottery || !!t.payment_deadline)
    .map((d) => {
      const ok = !!d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date);
      return {
        key: d.key,
        label: d.label,
        date: mdLabel(d.date),
        done: ok && (d.date as string) <= today,
      };
    });
}

function summaryRows(detail: RaceDetail): RaceKvRow[] {
  const weekday = shanghaiWeekdayLabel(detail.race_date);
  const place = [detail.province, detail.city].filter(Boolean).join('');
  const startName = detail.items.find((it) => it.start_point?.name)?.start_point?.name;
  const badges = [cnBadgeOf(detail.label), waBadgeOf(detail.wa_label)].filter((s) => s !== '');
  const quotas = detail.items
    .map((it) => it.quota)
    .filter((q): q is number => q != null && q > 0);
  const scale = quotas.length
    ? `${quotas.reduce((a, b) => a + b, 0).toLocaleString('en-US')} 人`
    : '待定';
  return [
    { k: '比赛日', v: weekday ? `${detail.race_date} ${weekday}` : detail.race_date },
    { k: '起跑时间', v: firstStartTime(detail.items) || '待定' },
    { k: '地点', v: [place, startName].filter(Boolean).join(' · ') || '待定' },
    { k: '认证', v: badges.join(' · ') || '—' },
    { k: '项目', v: detail.items.map((it) => it.name).join(' / ') || '—' },
    { k: '规模', v: scale },
  ];
}

function channelRows(detail: RaceDetail): RaceChannelRow[] {
  return (detail.signup_channels ?? []).map((c, i) => ({
    key: String(i),
    name: c.name,
    type: c.type,
    copyUrl: c.url_type === 'web' && c.url ? c.url : '',
  }));
}

function itemSection(it: RaceItem): RaceItemSection {
  const ends = [it.start_point?.name, it.finish_point?.name].filter(Boolean);
  return {
    id: it.id,
    title: it.name,
    rows: [
      { k: '距离', v: it.distance_km != null ? `${it.distance_km} km` : '待定' },
      {
        k: '名额',
        v: it.quota != null && it.quota > 0 ? `${it.quota.toLocaleString('en-US')} 人` : '待定',
      },
      { k: '起终点', v: ends.join(' → ') || '待定' },
      { k: '发枪', v: it.start_time || '待定' },
      { k: '报名费', v: feeLabel(it.entry_fee) },
    ],
    route: it.route_description || '',
  };
}

function tripView(detail: RaceDetail): RaceTripView {
  const city = detail.city_content;
  let cityView: RaceTripView['city'] = null;
  if (city) {
    const intro = city.intro;
    const paragraphs = intro
      ? (
          [
            ['概览', intro.overview],
            ['人文', intro.culture],
            ['美食', intro.food],
            ['历史', intro.history],
          ] as Array<[string, string]>
        ).filter(([, text]) => !!text)
      : [];
    cityView = {
      title: `城市 · ${city.city}`,
      paragraphs: paragraphs.map(([k, v]) => ({ k, v })),
      attractions: (city.attractions ?? []).map((a) => ({
        name: a.name,
        description: a.description,
      })),
    };
  }
  return {
    pickups: (detail.packet_pickup ?? []).map((p, i) => ({
      key: String(i),
      time: p.time,
      location: p.location,
    })),
    city: cityView,
  };
}

/** 详情数据 → 页面渲染模型。today 注入以便自检可复现。 */
export function toDetailView(detail: RaceDetail, today: string): RaceDetailView {
  return {
    head: {
      name: detail.name_cn || detail.name,
      cnBadge: cnBadgeOf(detail.label),
      waBadge: waBadgeOf(detail.wa_label),
      grid: headGrid(detail, today),
      timeline: timelineSteps(detail, today),
    },
    summary: summaryRows(detail),
    channels: channelRows(detail),
    items: detail.items.map(itemSection),
    trip: tripView(detail),
  };
}

/* ───────────────────────── 报名选择器（#393 唯一计划创建入口） ───────────────────────── */

/** 四态报名状态 → 中文标签（storage.RacePlanState* 词汇；选择器选项与按钮共用）。 */
const PLAN_STATE_LABELS: Record<RacePlanState, string> = {
  registered: '已报名（等抽签）',
  won: '已中签',
  lost: '未中签',
  confirmed: '确认参赛',
};

/** 选择器的状态选项：none = 未报名 · 取消追踪（删计划）。 */
export interface PlanStateOption {
  value: RacePlanState | 'none';
  label: string;
}

export const PLAN_STATE_OPTIONS: PlanStateOption[] = [
  { value: 'none', label: '未报名 · 取消追踪' },
  { value: 'registered', label: PLAN_STATE_LABELS.registered },
  { value: 'won', label: PLAN_STATE_LABELS.won },
  { value: 'lost', label: PLAN_STATE_LABELS.lost },
  { value: 'confirmed', label: PLAN_STATE_LABELS.confirmed },
];

/** 报名项目 chip：项目 token 去重；typeAbbr 不认识的 token 回落项目名。 */
export interface RaceChip {
  token: string;
  label: string;
}

export function itemChips(items: RaceItem[]): RaceChip[] {
  const seen = new Map<string, string>();
  for (const it of items) {
    if (!seen.has(it.type)) seen.set(it.type, typeAbbr(it.type) || it.name);
  }
  return [...seen].map(([token, label]) => ({ token, label }));
}

/** 报名按钮文案：'未报名' 或 '全马 · 已报名（等抽签）'。 */
export function planButtonLabel(itemType: string, state: RacePlanState | 'none'): string {
  if (state === 'none') return '未报名';
  return `${typeAbbr(itemType) || itemType} · ${PLAN_STATE_LABELS[state]}`;
}
