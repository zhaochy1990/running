// 教练结构化产物卡片注册表 —— 配套 utils/coachCards.check.mts 自检
// （`node --import ./utils/ts-resolve-hooks.mjs utils/coachCards.check.mts`）。
//
// 后端（coach_agent_api publicResponse）按本轮 intent 把结构化产物以
// `done.card = { $type, data }` 信封下发；这里把信封翻译成聊天气泡里的
// 通知卡片展示属性（标题/副标题/角标/CTA/目标页面），聊天页与卡片组件
// 不感知各产物类型的细节。已注册 race-strategy / master-plan，未来
// weekly-plan 再加一条（接入指南见 docs/coach_agent/structured-artifacts.md）。
//
// 历史自愈：后端防御解析上线前，弱模型曾把信封 JSON 当正文写进会话历史；
// parseLeakedEnvelope 用同一套形状校验把这类历史文本捞回成卡片信封。

import type { CoachSessionTarget } from '../services/coach';
import type { MasterPlanCard } from '../services/master-plan';
import type { RaceStrategy } from '../services/race-strategy';

/** done.card 的 wire 形态镜像（$type = 双端约定的渲染器 key）。 */
export interface CoachCardWire {
  $type: string;
  data: unknown;
}

/** 聊天气泡里的通知卡片（展示属性全部由注册表产出，组件只管渲染）。 */
export interface CoachCardView {
  /** 渲染器 key（wxml 分发用），如 'race-strategy'。 */
  type: string;
  /** 卡片图标（assets 路径）。 */
  icon: string;
  title: string;
  subtitle: string;
  /** 角标（如「初稿」）；空则不显示。 */
  badge: string;
  /** CTA 按钮文案；空则不渲染按钮。 */
  buttonText: string;
  /** 次级动作按钮文案（如 master-plan 的「放弃」）；空则不渲染。 */
  secondaryButtonText: string;
  /** CTA 目标页面（含 query）；空则卡片不可跳转。 */
  url: string;
  /** 产物本体：tap 时经 storage 交接给目标页（如报告页草稿模式）。 */
  data: unknown;
  /**
   * 摘要即卡片（master-plan 模式）：true 时聊天页在卡片头部下方继续渲染
   * markdown 正文摘要，卡片不替代正文——没有独立详情页的产物靠它把完整
   * 摘要留在会话里。
   */
  inlineBody: boolean;
}

/** 策略内容的形状校验（RaceStrategySchema 的鸭子类型版；数值口径由后端 zod 把关）。
 * 注意与 services/race-strategy.ts 的 storage 守卫刻意各自独立：那边不能
 * runtime import utils（会把 enum 链拖进 node 自检的 strip-only 运行时）。 */
function isRaceStrategyLike(value: unknown): value is RaceStrategy {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.race_name === 'string' && v.race_name.length > 0 &&
    typeof v.item_type === 'string' && v.item_type.length > 0 &&
    typeof v.target_finish_time === 'string' &&
    Array.isArray(v.pace_segments) && v.pace_segments.length > 0
  );
}

/** 计划卡内容的形状校验（MasterPlanCardSchema 的鸭子类型版，同上口径）。 */
function isMasterPlanCardLike(value: unknown): value is MasterPlanCard {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const goal = v.goal as Record<string, unknown> | undefined;
  return (
    goal != null && typeof goal === 'object' &&
    typeof goal.race_name === 'string' && goal.race_name.length > 0 &&
    typeof v.total_weeks === 'number' && v.total_weeks > 0
  );
}

/** done.card → 卡片视图；信封不认识/形状不对/缺 race target 时返回 null（降级走 markdown）。 */
export function buildCoachCard(card: unknown, target: CoachSessionTarget | undefined): CoachCardView | null {
  if (card == null || typeof card !== 'object') return null;
  const wire = card as Partial<CoachCardWire>;
  if (typeof wire.$type !== 'string' || wire.$type.length === 0) return null;
  if (wire.$type === 'race-strategy') {
    if (!isRaceStrategyLike(wire.data)) return null;
    const strategy = wire.data;
    const raceId = target?.kind === 'race' ? target.race_event_id : undefined;
    // 无 race target 时无法定位赛事（策略生成本就依赖 race target，这里只是防御）：
    // 仍出卡片展示，CTA 指向赛事中心。
    return {
      type: wire.$type,
      icon: '/assets/icons/flag.svg',
      title: '比赛策略已生成',
      subtitle: `${strategy.race_name} · 目标 ${strategy.target_finish_time}，含 ${strategy.pace_segments.length} 段配速与补给计划`,
      badge: '初稿',
      // 「查看并应用」会让用户以为点击即应用——实际是进报告页查看，应用在报告页内确认
      buttonText: '查看详情',
      secondaryButtonText: '',
      url: raceId
        ? `/pages/race-center/strategy/strategy?id=${raceId}`
        : '/pages/race-center/race-center',
      data: strategy,
      inlineBody: false,
    };
  }
  if (wire.$type === 'master-plan') {
    if (!isMasterPlanCardLike(wire.data)) return null;
    const plan = wire.data;
    // 摘要即卡片（#428：不做独立详情页）：卡片头部之下渲染 markdown 摘要正文。
    // #429：落库成功带 plan_id 的卡片出「启用/放弃」双 CTA（动作型，聊天页
    // onCardCta/onCardSecondary 直调底座端点，不走 url 跳转）；无 plan_id 的
    // 旧卡片/降级卡片保持纯展示。
    const planId = typeof plan.plan_id === 'string' && plan.plan_id.length > 0 ? plan.plan_id : '';
    return {
      type: wire.$type,
      icon: '/assets/icons/calendar_month.svg',
      title: '赛季训练计划已生成',
      subtitle: masterPlanSubtitle(plan),
      badge: '初稿',
      buttonText: planId ? '启用' : '',
      secondaryButtonText: planId ? '放弃' : '',
      url: '',
      data: plan,
      inlineBody: true,
    };
  }
  return null;
}

function masterPlanSubtitle(plan: MasterPlanCard): string {
  const distance = plan.goal.distance === 'FM' ? '全马' : '半马';
  const target = plan.goal.target_time ? `，目标 ${plan.goal.target_time}` : '';
  return `${plan.goal.race_name}（${distance}） · ${plan.total_weeks} 周备赛${target}`;
}

/**
 * 历史消息自愈：正文若是泄漏的**比赛策略**信封 JSON（裸 `{` 开头），捞回成
 * 卡片信封。与后端 parseRaceStrategyFromText 同口径（信封/裸对象双形状），
 * 只做形状校验、不做数值复验——历史数据原样展示。其他产物类型泄漏时在此
 * 按注册表扩展判定。
 */
export function parseLeakedRaceStrategyEnvelope(content: string): CoachCardWire | null {
  // 与后端同口径：先剥整段 ```json 围栏（泄漏的另一形态），再要求裸 `{` 开头。
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(content.trim());
  const text = (fence?.[1] ?? content).trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed != null && typeof parsed === 'object') {
      if (parsed.disposition === 'return_direct' && parsed.content != null) {
        return { $type: 'race-strategy', data: parsed.content };
      }
      return { $type: 'race-strategy', data: parsed };
    }
  } catch {
    /* 非整段 JSON：按普通文本处理 */
  }
  return null;
}

/** 流式正文是否「形似 JSON 泄漏」（旧后端防御）：呈现层换成占位文案。 */
export function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) return true;
  if (trimmed.startsWith('Returning structured response:')) return true;
  return trimmed.slice(0, 120).includes('"disposition"');
}
