// Static notification messages shown to users after login.
// Edit this file locally and re-deploy — the new messages will appear in the
// message center. Messages are immutable: once published, never
// rewrite the same `id` with different content.  Add a new entry instead.

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error'
export type NotificationStatus = 'queued' | 'running' | 'done' | 'failed' | 'info'

export interface AppNotification {
  id: string
  title: string
  body: string
  publishedAt: string // ISO date string
  severity?: NotificationSeverity
  status?: NotificationStatus
  kind?: string
  updatedAt?: string
  sourceType?: string | null
  sourceId?: string | null
  actionUrl?: string | null
  progressPct?: number | null
  read?: boolean
  readAt?: string | null
  metadata?: Record<string, unknown>
}

function parseNotificationTime(value: string | null | undefined): number | null {
  if (!value) return null
  let normalized = value
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    normalized = `${value}T00:00:00+08:00`
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    normalized = `${value}+08:00`
  }
  const parsed = Date.parse(normalized)
  return Number.isNaN(parsed) ? null : parsed
}

// Newest-first ordering is enforced at render time, but keeping the source
// list in published order makes diffs readable.
export const NOTIFICATIONS: AppNotification[] = [
  {
    id: '2026-04-30-custom-domain',
    title: '新域名上线：stride-running.cn',
    body:
      'STRIDE 已经启用全新的访问地址：https://stride-running.cn 。这个域名更短、更好记，欢迎大家更新书签并使用新地址访问。原来的 Azure 链接也仍然可用，登录信息无需重新配置。',
    publishedAt: '2026-04-30T20:00',
    severity: 'success',
  },
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

export function getNotificationsForUser(userStartedAt?: string | null): AppNotification[] {
  const startedAt = parseNotificationTime(userStartedAt)
  if (startedAt === null) return [...NOTIFICATIONS]
  return NOTIFICATIONS.filter((notification) => {
    const publishedAt = parseNotificationTime(notification.publishedAt)
    return publishedAt === null || publishedAt > startedAt
  })
}

export function getNotificationsNewestFirst(
  notifications: readonly AppNotification[] = NOTIFICATIONS,
): AppNotification[] {
  return [...notifications].sort(
    (a, b) => (b.updatedAt ?? b.publishedAt).localeCompare(a.updatedAt ?? a.publishedAt),
  )
}

export interface ServerNotification {
  id: string
  title: string
  body: string
  kind?: string
  status?: NotificationStatus
  severity?: NotificationSeverity
  published_at?: string
  updated_at?: string
  source_type?: string | null
  source_id?: string | null
  action_url?: string | null
  progress_pct?: number | null
  metadata?: Record<string, unknown>
  read?: boolean
  read_at?: string | null
}

export function fromServerNotification(item: ServerNotification): AppNotification {
  return {
    id: item.id,
    title: item.title,
    body: item.body,
    kind: item.kind,
    status: item.status,
    severity: item.severity,
    publishedAt: item.published_at ?? item.updated_at ?? '',
    updatedAt: item.updated_at,
    sourceType: item.source_type,
    sourceId: item.source_id,
    actionUrl: item.action_url,
    progressPct: item.progress_pct,
    metadata: item.metadata,
    read: item.read,
    readAt: item.read_at,
  }
}
