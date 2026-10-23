// 教练聊天分享阅读端视图模型（devops#718）—— 纯函数，配套 coachShareRows.check.mts
// 自检（`node --import ./utils/ts-resolve-hooks.mjs utils/coachShareRows.check.mts`）。
//
// 快照消息形态与 coach 页历史一致（user 纯文本 / assistant markdown / 卡片
// 信封），卡片按 utils/coachCards 注册表翻译成阅读端的静态摘要卡：
//   race-strategy → 静态摘要卡（icon/标题/摘要 + 引导文案）。#624 Q2 的
//     「查看详情」跳 #506 免登录页依赖快照三元组 user_id/race_id/version_id，
//     而 v1 服务端读取响应不投影三元组、version_id 生成期本就不存在（见
//     coach_agent_api routes/shares.ts extractStrategyRefs 注释「无版本则不
//     给 #506 跳转」），故阅读端按该口径降级为纯静态卡；
//   master-plan → 卡头 + inlineBody markdown 照常渲染（摘要即卡片）；
//   其余类型（custom-workout / workout-op 动作卡）/形状不符 → 降级为普通
//     markdown 气泡（注册表既有口径：动作型 CTA 对只读者无意义）。

import { buildCoachCard } from './coachCards';
import { markdownToHtml } from './markdown';
import type { CoachShareMessage } from '../services/coach';

/** 阅读端静态摘要卡（只展示，无 CTA）。 */
export interface CoachShareCardVM {
  icon: string;
  title: string;
  subtitle: string;
  /** true = 卡头下方继续渲染 markdown 正文（master-plan 摘要即卡片）。 */
  inlineBody: boolean;
}

export interface CoachShareMessageVM {
  id: number;
  role: 'user' | 'assistant';
  /** user 为空串；assistant = markdownToHtml(content)（mp-html 渲染）。 */
  html: string;
  /** 静态摘要卡；null = 无卡片信封或已降级走 markdown 气泡。 */
  card: CoachShareCardVM | null;
}

/** 快照消息 → 阅读端气泡视图模型（id 即快照数组序号，wx:key 用）。 */
export function buildCoachShareMessages(messages: CoachShareMessage[]): CoachShareMessageVM[] {
  return messages.map((message, index) => {
    if (message.role !== 'assistant') {
      return { id: index, role: 'user', html: '', card: null };
    }

    let card: CoachShareCardVM | null = null;
    if (message.card) {
      const view = buildCoachCard(message.card, undefined);
      // 注册表不认识/形状不符 → null 走 markdown；动作卡（待保存/待确认类）
      // 对只读接收者无意义，也一并降级，只保留静态摘要两类。
      if (view && (view.type === 'race-strategy' || view.type === 'master-plan')) {
        card = { icon: view.icon, title: view.title, subtitle: view.subtitle, inlineBody: view.inlineBody };
      }
    }

    return {
      id: index,
      role: 'assistant',
      // race-strategy 卡替代正文（coach 页 cardCoachMessage 同口径）；master-plan
      // 摘要即卡片，正文照常渲染。
      html: card && !card.inlineBody ? '' : markdownToHtml(message.content),
      card,
    };
  });
}
