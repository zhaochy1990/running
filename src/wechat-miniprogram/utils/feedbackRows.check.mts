// feedbackRows.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/feedbackRows.check.mts`。
// 覆盖 UTC→上海墙钟平移（跨日/月初）、时间标签（今天/昨天/同年旧日期/跨年）、
// 会话末条预览前缀、会话行映射（emoji/标题截断/已采纳/未读）。
import {
  conversationPreview,
  feedbackTimeLabel,
  shanghaiWallClock,
  toConvRows,
  ymdOffset,
} from './feedbackRows.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// ── UTC → 上海墙钟：+8h，UTC 16:02 → 上海次日 00:02（跨日）──
eq(shanghaiWallClock('2026-10-16T16:02:00Z'), { ymd: '2026-10-17', hm: '00:02' }, 'utc +8 crosses day');
eq(shanghaiWallClock('2026-10-16T06:11:00Z'), { ymd: '2026-10-16', hm: '14:11' }, 'utc +8 same day');
// 带非零偏移的 ISO 也正确归一
eq(shanghaiWallClock('2026-10-16T22:11:00+08:00'), { ymd: '2026-10-16', hm: '22:11' }, 'explicit offset');
// 上海月初回退：UTC 10-31 20:00 → 上海 11-01 04:00
eq(shanghaiWallClock('2026-10-31T20:00:00Z'), { ymd: '2026-11-01', hm: '04:00' }, 'month rollover');
eq(shanghaiWallClock(''), null, 'empty → null');
eq(shanghaiWallClock('not-a-date'), null, 'invalid → null');
eq(shanghaiWallClock(undefined), null, 'undefined → null');

// ── ymdOffset：跨月/跨年 ──
eq(ymdOffset('2026-03-01', -1), '2026-02-28', 'offset across month');
eq(ymdOffset('2027-01-01', -1), '2026-12-31', 'offset across year');

// ── 时间标签 ──
// now = 上海 2026-10-16 14:00（= UTC 06:00）
const now = Date.parse('2026-10-16T06:00:00Z');
const todaySh = shanghaiWallClock('2026-10-16T06:00:00Z');
eq(todaySh, { ymd: '2026-10-16', hm: '14:00' }, 'now wall clock');
eq(feedbackTimeLabel('2026-10-16T06:02:00Z', now), '14:02', 'today → HH:MM');
// 上海昨天 21:15 = UTC 13:15
eq(feedbackTimeLabel('2026-10-15T13:15:00Z', now), '昨天 21:15', 'yesterday');
eq(feedbackTimeLabel('2026-10-12T01:40:00Z', now), '10-12 09:40', 'older same year');
eq(feedbackTimeLabel('2025-09-28T10:26:00Z', now), '2025-09-28 18:26', 'cross year keeps year');
eq(feedbackTimeLabel('garbage', now), '', 'invalid → empty');

// ── 末条预览 ──
eq(conversationPreview({ content: '配速图缺失', last_reply: null }), '配速图缺失', 'no reply → content');
eq(
  conversationPreview({ content: 'c', last_reply: { author: 'admin', content: '已收到', created_at: '' } }),
  '官方：已收到',
  'admin prefix',
);
eq(
  conversationPreview({ content: 'c', last_reply: { author: 'user', content: '补充截图', created_at: '' } }),
  '我：补充截图',
  'user prefix',
);

// ── 会话行映射 ──
const rows = toConvRows(
  [
    {
      id: 3,
      type: 'suggestion' as const,
      content: '第一行标题很长很长很长很长很长很长很长第二行\n第二行',
      images: [],
      status: 'replied' as const,
      adopted_feature_id: 7,
      created_at: '2026-10-12T01:40:00Z',
      last_reply: { author: 'admin', content: '已采纳进路线', created_at: '2026-10-13T02:02:00Z' },
      unread: true,
    },
    {
      id: 4,
      type: 'bug' as const,
      content: '带图 bug',
      images: ['feedback/x/1.jpg'],
      status: 'open' as const,
      adopted_feature_id: null,
      created_at: '2026-10-16T05:00:00Z',
      last_reply: null,
      unread: false,
    },
  ],
  now,
);
eq(
  rows,
  [
    { id: 3, emoji: '💡', title: '第一行标题很长很长很长很长很长很长很长第', adopted: true, time: '10-12 09:40', preview: '官方：已采纳进路线', unread: true },
    { id: 4, emoji: '🐞', title: '带图 bug', adopted: false, time: '13:00', preview: '带图 bug', unread: false },
  ],
  'conv rows mapping',
);

console.log('feedbackRows.check: all assertions passed');
