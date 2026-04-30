// Static notification messages shown to users after login.
// Edit this file locally and re-deploy — the new messages will appear in the
// popup + message center.  Messages are immutable: once published, never
// rewrite the same `id` with different content.  Add a new entry instead.

export type NotificationSeverity = 'info' | 'success' | 'warning'

export interface AppNotification {
  id: string
  title: string
  body: string
  publishedAt: string // ISO date string
  severity?: NotificationSeverity
}

// Newest-first ordering is enforced at render time, but keeping the source
// list in published order makes diffs readable.
export const NOTIFICATIONS: AppNotification[] = [
  {
    id: '2026-04-30-top-nav-and-message-center',
    title: '新功能：顶部导航 & 消息中心',
    body:
      '我们调整了页面布局：用户资料和登出按钮已经移动到屏幕右上角，旁边新增了消息中心入口。今后所有的产品更新都会通过消息中心推送，关闭弹窗后仍可在消息中心查看历史。',
    publishedAt: '2026-04-30',
    severity: 'info',
  },
  {
    id: '2026-04-24-aoai-auto-commentary',
    title: '训练点评现在自动生成',
    body:
      '每次同步 COROS 数据后，系统会自动用 GPT-4.1 为新的训练写一条点评草稿。你可以在活动详情页面手动重新生成或由教练进一步润色。',
    publishedAt: '2026-04-24',
    severity: 'success',
  },
]

export function getLatestNotification(): AppNotification | undefined {
  if (NOTIFICATIONS.length === 0) return undefined
  return [...NOTIFICATIONS].sort(
    (a, b) => b.publishedAt.localeCompare(a.publishedAt),
  )[0]
}

export function getNotificationsNewestFirst(): AppNotification[] {
  return [...NOTIFICATIONS].sort(
    (a, b) => b.publishedAt.localeCompare(a.publishedAt),
  )
}
