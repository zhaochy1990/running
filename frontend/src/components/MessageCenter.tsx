import { useEffect, useRef, useState } from 'react'
import { getNotificationsNewestFirst } from '../data/notifications'
import { useNotificationsStore } from '../store/notificationsStore'

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-accent-cyan',
  success: 'bg-accent-green',
  warning: 'bg-accent-amber',
}

export default function MessageCenter() {
  const dismiss = useNotificationsStore((s) => s.dismiss)
  const isDismissed = useNotificationsStore((s) => s.isDismissed)
  const unreadCount = useNotificationsStore((s) => s.unreadCount)
  // Subscribe to dismissed so the panel re-renders.
  useNotificationsStore((s) => s.dismissed)

  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const messages = getNotificationsNewestFirst()
  const unread = unreadCount()

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="消息中心"
        aria-label="消息中心"
        aria-haspopup="true"
        aria-expanded={open}
        data-testid="message-center-trigger"
        className="relative flex items-center justify-center w-9 h-9 rounded-lg border border-border-subtle bg-bg-card text-text-secondary hover:bg-bg-card-hover hover:text-text-primary transition-colors cursor-pointer"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span
            data-testid="message-center-badge"
            className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-accent-red text-white text-[10px] font-bold leading-[18px] text-center"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="message-center-panel"
          className="absolute right-0 mt-2 w-[min(92vw,360px)] rounded-2xl border border-border bg-bg-card shadow-2xl z-50 overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
            <span className="text-sm font-semibold text-text-primary">消息中心</span>
            <span className="text-[11px] font-mono text-text-muted">
              {unread > 0 ? `${unread} 条未读` : '全部已读'}
            </span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {messages.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-muted">暂无消息</div>
            ) : (
              <ul>
                {messages.map((m) => {
                  const read = isDismissed(m.id)
                  const dot = SEVERITY_DOT[m.severity ?? 'info'] ?? SEVERITY_DOT.info
                  return (
                    <li
                      key={m.id}
                      className={`px-4 py-3 border-b border-border-subtle last:border-b-0 transition-colors ${
                        read ? 'bg-bg-card' : 'bg-bg-card-hover'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className={`mt-1.5 inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                            read ? 'bg-border opacity-60' : dot
                          }`}
                          aria-hidden="true"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className={`text-sm leading-snug ${read ? 'text-text-secondary' : 'font-semibold text-text-primary'}`}>
                              {m.title}
                            </p>
                            <span className="text-[10px] font-mono text-text-muted flex-shrink-0">
                              {m.publishedAt.slice(0, 10)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-text-secondary whitespace-pre-line">
                            {m.body}
                          </p>
                          {!read && (
                            <button
                              type="button"
                              onClick={() => dismiss(m.id)}
                              className="mt-2 text-[11px] font-mono text-accent-green hover:underline cursor-pointer"
                            >
                              标记为已读
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
