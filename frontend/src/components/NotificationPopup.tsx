import { useEffect, useState } from 'react'
import { useNotificationsStore } from '../store/notificationsStore'

const SEVERITY_ACCENT: Record<string, string> = {
  info: 'border-accent-cyan/40 bg-accent-cyan/5',
  success: 'border-accent-green/40 bg-accent-green/5',
  warning: 'border-accent-amber/40 bg-accent-amber/5',
}

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-accent-cyan',
  success: 'bg-accent-green',
  warning: 'bg-accent-amber',
}

export default function NotificationPopup() {
  const pendingPopup = useNotificationsStore((s) => s.pendingPopup)
  const dismiss = useNotificationsStore((s) => s.dismiss)
  // Subscribe to dismissed so re-renders happen when state changes.
  useNotificationsStore((s) => s.dismissed)

  const [visible, setVisible] = useState(false)
  const message = pendingPopup()

  const messageId = message?.id

  useEffect(() => {
    if (!messageId) return
    // Small delay so the popup eases in after the layout mounts.
    const t = setTimeout(() => setVisible(true), 120)
    return () => clearTimeout(t)
  }, [messageId])

  if (!message) return null

  const accent = SEVERITY_ACCENT[message.severity ?? 'info'] ?? SEVERITY_ACCENT.info
  const dot = SEVERITY_DOT[message.severity ?? 'info'] ?? SEVERITY_DOT.info

  const close = () => {
    setVisible(false)
    setTimeout(() => dismiss(message.id), 180)
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 pointer-events-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notification-popup-title"
    >
      <div
        className={`fixed inset-0 bg-black/30 transition-opacity duration-200 ${
          visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={close}
      />
      <div
        className={`relative w-full max-w-md rounded-2xl border bg-bg-card p-6 shadow-2xl transition-all duration-200 ${accent} ${
          visible ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
      >
        <div className="flex items-start gap-3">
          <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${dot}`} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h2
              id="notification-popup-title"
              className="text-base font-semibold text-text-primary leading-snug"
            >
              {message.title}
            </h2>
            <p className="mt-1 text-[11px] font-mono text-text-muted tracking-wider">
              {message.publishedAt.slice(0, 10)}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary whitespace-pre-line">
              {message.body}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-border px-4 py-1.5 text-sm font-medium text-text-secondary bg-bg-card hover:bg-bg-card-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
