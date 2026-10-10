// 「我的赛事」计划卡的纯视图模型构建 —— 不依赖小程序运行时，
// 配套 utils/racePlanRows.check.mts 自检（`node --import ./utils/ts-resolve-hooks.mjs
// utils/racePlanRows.check.mts`）。页面（pages/my-races）负责请求与交互，
// 这里只做 计划 DTO → 卡片视图 的确定性变换。版式与状态机见 #385 定稿 / #394。

import type { RacePlan, RacePlanState } from '../services/race-plans';
import { shanghaiToday, shanghaiWeekdayLabel } from './date';
import { typeAbbr } from './raceCenterRows';
import { daysUntil } from './raceDetailRows';

/** 状态全称（卡头徽章用）；chip 上用短名（steps 里去掉「· 等抽签」尾缀）。 */
const STATE_LABELS: Record<RacePlanState, string> = {
  registered: '已报名 · 等抽签',
  won: '已中签',
  lost: '未中签',
  confirmed: '确认参赛',
};

/** 状态条的三态流转序列（未中签是独立旁路状态，不进 chips）。 */
const STATE_FLOW: RacePlanState[] = ['registered', 'won', 'confirmed'];

/** 状态切换后卡片的可变部分：徽章文案、chips 点亮、未中签引导行可见性。
 *  页面乐观更新与失败回滚都用它算补丁，与 toPlanCard 同源不漂移。 */
export function statePatch(
  state: RacePlanState,
): Pick<PlanCardView, 'state' | 'stateLabel' | 'steps' | 'lost'> {
  return {
    state,
    stateLabel: STATE_LABELS[state],
    steps: STATE_FLOW.map((s) => ({
      state: s,
      label: STATE_LABELS[s].replace(' · 等抽签', ''),
      on: s === state,
    })),
    lost: state === 'lost',
  };
}

/** 计划卡的渲染模型：全部字段预格式化，wxml 不做表达式逻辑。 */
export interface PlanCardView {
  /** wx:key：一人一赛一计划，race_id 即唯一 */
  raceId: number;
  /** 赛事投影被物理删除（race=null）时无名单可用，回落占位文案 */
  name: string;
  /** 报名项目缩写（全马/半马/10K），未知 token 为 '—' */
  itemLabel: string;
  /** racetypes token 原文，回写 upsert 时必带（binding:required） */
  itemToken: string;
  state: RacePlanState;
  stateLabel: string;
  /** 2026/11/01 周日 */
  dateLabel: string;
  city: string;
  /** 开赛倒计时文案（N>0「距离比赛还有 N 天」/ 当天「今天开赛」）；已结束或无日期为 ''，wxml 隐藏 */
  countdown: string;
  /** 状态条 chips：已报名→已中签→确认参赛（短名） */
  steps: Array<{ state: RacePlanState; label: string; on: boolean }>;
  /** 未中签旁路：卡上给「去找替代赛事」转化引导 */
  lost: boolean;
  hotel: boolean;
  transit: boolean;
  offboarded: boolean;
}

export function toPlanCard(plan: RacePlan): PlanCardView {
  const itemLabel = typeAbbr(plan.item_type);
  return {
    raceId: plan.race_id,
    name: plan.race?.name_cn || plan.race?.name || '已下架赛事',
    itemLabel: itemLabel || '—',
    itemToken: plan.item_type,
    ...statePatch(plan.state),
    dateLabel: plan.race ? planDateLabel(plan.race.race_date) : '',
    city: plan.race?.city || '',
    countdown: countdownLabel(plan.race ? daysUntil(plan.race.race_date, shanghaiToday()) : null),
    hotel: plan.hotel,
    transit: plan.transit,
    offboarded: plan.offboarded,
  };
}

/** YYYY-MM-DD → 「2026/11/01 周日」——官方计划卡与自定义卡（myRaceRows）共用的日期列。 */
export function planDateLabel(ymd: string): string {
  return `${ymd.slice(0, 4)}/${ymd.slice(5).replace('-', '/')} ${shanghaiWeekdayLabel(ymd)}`;
}

/** 开赛倒计时文案；null（无日期）/ 负数（已结束）不给文案。自定义卡同源复用。 */
export function countdownLabel(days: number | null): string {
  if (days == null || days < 0) return '';
  return days > 0 ? `距离比赛还有 ${days} 天` : '今天开赛';
}
