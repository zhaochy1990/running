// 赛事中心密表行的纯视图模型构建 —— 不依赖小程序运行时，
// 配套 utils/raceCenterRows.check.mts 自检（`node utils/raceCenterRows.check.mts`）。
// 页面（pages/race-center）负责请求与交互，这里只做 数据 → 行/分组 的确定性变换。

import type { RaceCalendarRace } from '../services/race-center';
import { shanghaiWeekdayLabel } from './date';

// 标签全称双徽章（#392）：名下方一行，田协 + 世界田联各至多一枚。
// 值域见 race_calendar 同步侧（中国田协 A/B/C/C（属地办赛）/系列赛；
// WA Gold/Platinum/Label/Elite）。未知取值不显示，避免编造认证。
const CN_LABEL_BADGES: Record<string, string> = {
  A: '中国田协A类赛事',
  B: '中国田协B类赛事',
  C: '中国田协C类赛事',
  'C（属地办赛）': '中国田协C类（属地办赛）',
  系列赛: '中国田协系列赛',
};

const WA_LABEL_BADGES: Record<string, string> = {
  Gold: '世界田联金标',
  Platinum: '世界田联白金标',
  Label: '世界田联标牌',
  Elite: '世界田联精英标',
};

/** 田协认证值 → 徽章全称；null 与未知取值返回 ''（不编造认证）。详情页认证行复用。 */
export function cnBadgeOf(label: string | null | undefined): string {
  return label ? CN_LABEL_BADGES[label] || '' : '';
}

/** 世界田联标牌值 → 徽章全称；null 与未知取值返回 ''。 */
export function waBadgeOf(waLabel: string | null | undefined): string {
  return waLabel ? WA_LABEL_BADGES[waLabel] || '' : '';
}

/** 项目 token → 密表缩写。{n}Km 去掉单位压成 {n}K（10Km→10K、5.2Km→5.2K）。 */
export function typeAbbr(token: string): string {
  if (token === 'Marathon') return '全马';
  if (token === 'HalfMarathon') return '半马';
  const m = /^(\d+(?:\.\d+)?)Km$/.exec(token);
  if (m) return `${m[1]}K`;
  return '';
}

/** 一行密表的渲染模型：全部字段预格式化，wxml 不做表达式逻辑。 */
export interface RaceRowView {
  id: number;
  /** MM/DD */
  dateLabel: string;
  /** 周五 */
  weekday: string;
  name: string;
  /** 田协徽章全称，''=隐藏 */
  cnBadge: string;
  /** 世界田联徽章全称，''=隐藏 */
  waBadge: string;
  /** 项目缩写序列，如 全马/半马；无已知项目时为 '—' */
  typesLabel: string;
  city: string;
  starred: boolean;
}

/** 月份分组：一组一个粘性头。 */
export interface RaceMonthGroup {
  /** YYYY-MM，wxml 的 wx:key */
  key: string;
  /** 10月 */
  label: string;
  rows: RaceRowView[];
}

export interface RaceFilter {
  /** racetypes token；''=全部 */
  type: string;
  /** 仅收藏 */
  favoritesOnly: boolean;
}

export function toRowView(r: RaceCalendarRace): RaceRowView {
  const abbrs = (r.race_types || [])
    .map(typeAbbr)
    .filter((s) => s !== '');
  return {
    id: r.id,
    dateLabel: r.race_date.slice(5).replace('-', '/'),
    weekday: shanghaiWeekdayLabel(r.race_date),
    name: r.name_cn || r.name,
    cnBadge: cnBadgeOf(r.label),
    waBadge: waBadgeOf(r.wa_label),
    typesLabel: abbrs.join('/') || '—',
    city: r.city || '—',
    starred: r.favorited,
  };
}

/** 客户端筛选：type 匹配事件的 race_types 数组。省份/年份走服务端参数。 */
export function filterRaces(races: RaceCalendarRace[], f: RaceFilter): RaceCalendarRace[] {
  return races.filter((r) => {
    if (f.favoritesOnly && !r.favorited) return false;
    if (f.type && !(r.race_types || []).includes(f.type)) return false;
    return true;
  });
}

/** 按比赛日升序分组（API 本身按 race_date 排序，这里防御性重排）。 */
export function groupByMonth(races: RaceCalendarRace[]): RaceMonthGroup[] {
  const sorted = [...races].sort((a, b) =>
    a.race_date === b.race_date ? a.id - b.id : a.race_date < b.race_date ? -1 : 1,
  );
  const groups: RaceMonthGroup[] = [];
  for (const r of sorted) {
    const ym = r.race_date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (!last || last.key !== ym) {
      groups.push({
        key: ym,
        label: `${parseInt(ym.slice(5, 7), 10)}月`,
        rows: [toRowView(r)],
      });
    } else {
      last.rows.push(toRowView(r));
    }
  }
  return groups;
}

