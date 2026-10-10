// 「我的赛事」混排列表的纯视图模型构建 —— 聚合端点 GET /api/users/me/my-races
//（#474）的 official 项复用 toPlanCard 零改动，custom 项（自定义比赛 #475）在这里
// 变换；配套 utils/myRaceRows.check.mts 自检（同 racePlanRows 模式，不依赖小程序运行时）。
// 排序（未结束按比赛日升序、已结束沉底）由后端完成，这里保序不重排。

import type { CustomRace, CustomRaceState, MyRaceItem } from '../services/custom-races';
import type { PlanCardView } from './racePlanRows';
import { countdownLabel, planDateLabel, toPlanCard } from './racePlanRows';
import { shanghaiToday } from './date';
import { daysUntil } from './raceDetailRows';

/** 表单 chips 与卡面徽章共用的七值类型词表（token ↔ 中文，#457 拍板扩 racetypes）。 */
export const CUSTOM_TYPE_CHIPS: ReadonlyArray<{ token: string; label: string }> = [
  { token: 'Marathon', label: '马拉松' },
  { token: 'HalfMarathon', label: '半马' },
  { token: '10Km', label: '10K' },
  { token: '5Km', label: '5K' },
  { token: 'Trail', label: '越野跑' },
  { token: 'Ultra', label: '超长越野' },
  { token: 'Other', label: '其他' },
];

const TYPE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CUSTOM_TYPE_CHIPS.map((chip) => [chip.token, chip.label]),
);

/** 两态徽章/chips 文案；「已结束」由日期派生（done），不进存储词表。 */
const CUSTOM_STATE_LABELS: Record<CustomRaceState, string> = {
  want: '想跑',
  registered: '已报名',
};

/** 状态切换后自定义卡的可变部分（乐观更新与失败回滚的补丁，同 statePatch 模式）。 */
export function customStatePatch(
  state: CustomRaceState,
): Pick<CustomCardView, 'state' | 'stateLabel' | 'steps'> {
  return {
    state,
    stateLabel: CUSTOM_STATE_LABELS[state],
    steps: (['want', 'registered'] as const).map((s) => ({
      state: s,
      label: CUSTOM_STATE_LABELS[s],
      on: s === state,
    })),
  };
}

/** 自定义比赛卡的渲染模型：全部字段预格式化，wxml 不做表达式逻辑。 */
export interface CustomCardView {
  id: number;
  name: string;
  /** 类型（距离）徽章：distance_km 空 → 只显类型，如「越野跑 50K」/「其他」 */
  badgeLabel: string;
  state: CustomRaceState;
  /** done 时为「已结束」 */
  stateLabel: string;
  /** 状态 chips：想跑 ↔ 已报名；done 时为空数组（wxml 隐藏状态条） */
  steps: Array<{ state: CustomRaceState; label: string; on: boolean }>;
  /** 日期 · 城市 · 爬升 D+，缺项自动省略 */
  metaLabel: string;
  /** 倒计时文案；done 时为 ''，wxml 隐藏 */
  countdown: string;
  done: boolean;
  /** 备注，空串隐藏（已结束卡不显） */
  note: string;
}

/** 一行混排卡：官方计划卡或自定义卡，wxml 按 kind 分支取 plan / custom。 */
export type MyRaceRow =
  | { kind: 'official'; key: string; plan: PlanCardView }
  | { kind: 'custom'; key: string; custom: CustomCardView };

export function toCustomCard(race: CustomRace): CustomCardView {
  const typeLabel = TYPE_LABELS[race.item_type] || race.item_type;
  const dist =
    race.distance_km == null
      ? ''
      : `${Number.isInteger(race.distance_km) ? race.distance_km : race.distance_km.toFixed(1)}K`;
  const base = customStatePatch(race.state);
  return {
    id: race.id,
    name: race.name,
    badgeLabel: dist ? `${typeLabel} ${dist}` : typeLabel,
    state: base.state,
    stateLabel: race.done ? '已结束' : base.stateLabel,
    steps: race.done ? [] : base.steps,
    metaLabel: [
      planDateLabel(race.race_date),
      race.city,
      race.ascent_m != null ? `爬升 D+${race.ascent_m}m` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    countdown: race.done ? '' : countdownLabel(daysUntil(race.race_date, shanghaiToday())),
    done: race.done,
    note: race.note || '',
  };
}

/** 聚合 items → 混排行序列，保序（后端已排好）；残缺项（source 与载荷不匹配）跳过。 */
export function toMyRaceRows(items: MyRaceItem[]): MyRaceRow[] {
  const rows: MyRaceRow[] = [];
  for (const item of items) {
    if (item.source === 'custom' && item.race) {
      rows.push({ kind: 'custom', key: `c-${item.race.id}`, custom: toCustomCard(item.race) });
    } else if (item.plan) {
      rows.push({ kind: 'official', key: `o-${item.plan.race_id}`, plan: toPlanCard(item.plan) });
    }
  }
  return rows;
}
