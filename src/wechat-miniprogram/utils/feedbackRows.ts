// 反馈会话行纯逻辑（devops#554，原型 518 variant C 定稿）。
// 后端 created_at / last_reply.created_at 是 UTC RFC3339；用户可读时间一律
// 按上海墙钟展示（timezone discipline：UTC 存储，Asia/Shanghai 展示）。
// 不引用 wx —— 供 utils/feedbackRows.check.mts 在 node 下自检。

import type { FeedbackItem } from '../services/feedback';

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 上海当天的 YYYY-MM-DD（由毫秒时刻推，等价 shanghaiToday 但可测）。 */
export function shanghaiYmdFromMs(nowMs: number): string {
  const sh = new Date(nowMs + 8 * 3600 * 1000);
  return `${sh.getUTCFullYear()}-${pad(sh.getUTCMonth() + 1)}-${pad(sh.getUTCDate())}`;
}

/** YYYY-MM-DD 偏移 n 天（UTC 数学，±跨月/跨年安全）。 */
export function ymdOffset(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * UTC RFC3339 → 上海墙钟 { ymd, hm }。+8h 平移后用 getUTC* 读墙钟
 * （miniprogram 侧等价 Go API 对 activity date 的上海偏移转换）。
 * 非法/缺失返回 null。
 */
export function shanghaiWallClock(iso: string | null | undefined): { ymd: string; hm: string } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const sh = new Date(t + 8 * 3600 * 1000);
  return {
    ymd: `${sh.getUTCFullYear()}-${pad(sh.getUTCMonth() + 1)}-${pad(sh.getUTCDate())}`,
    hm: `${pad(sh.getUTCHours())}:${pad(sh.getUTCMinutes())}`,
  };
}

/**
 * 会话/气泡时间标签：今天 HH:MM · 昨天 HH:MM · (跨年补年份) MM-DD HH:MM。
 */
export function feedbackTimeLabel(iso: string | null | undefined, nowMs: number): string {
  const wc = shanghaiWallClock(iso);
  if (!wc) return '';
  const today = shanghaiYmdFromMs(nowMs);
  if (wc.ymd === today) return wc.hm;
  if (wc.ymd === ymdOffset(today, -1)) return `昨天 ${wc.hm}`;
  const [, m, d] = wc.ymd.split('-');
  const yearPrefix = wc.ymd.slice(0, 4) === today.slice(0, 4) ? '' : `${wc.ymd.slice(0, 4)}-`;
  return `${yearPrefix}${m}-${d} ${wc.hm}`;
}

/** 列表末条预览：有官方/本人回复带前缀，否则显示原文。 */
export function conversationPreview(item: Pick<FeedbackItem, 'content' | 'last_reply'>): string {
  if (!item.last_reply) return item.content;
  return `${item.last_reply.author === 'user' ? '我：' : '官方：'}${item.last_reply.content}`;
}

/** 会话列表行（原型 C convRow）：emoji 头像 + 标题 + 已采纳角标 + 时间 + 预览 + 未读点。 */
export interface FeedbackConvRow {
  id: number;
  emoji: string;
  /** 正文首行截 20 字（反馈无标题字段，原型提交流即取前 20 字） */
  title: string;
  adopted: boolean;
  time: string;
  preview: string;
  unread: boolean;
}

export function toConvRows(items: FeedbackItem[], nowMs: number): FeedbackConvRow[] {
  return items.map((it) => ({
    id: it.id,
    emoji: it.type === 'bug' ? '🐞' : '💡',
    title: (it.content.split('\n')[0] || '').slice(0, 20),
    adopted: it.adopted_feature_id != null,
    time: feedbackTimeLabel(it.created_at, nowMs),
    preview: conversationPreview(it),
    unread: it.unread,
  }));
}
