import { useEffect, useRef, useState } from 'react'
import type { CoachSessionMeta } from '../../lib/coachSession'
import { ChevronIcon, PlusIcon } from './CoachIcons'

interface SessionSwitcherProps {
  sessions: CoachSessionMeta[]
  activeSessionId: string
  onSelect: (sessionId: string) => void
  onNew: () => void
}

/** Header dropdown to switch between coach conversations + start a new one. */
export default function SessionSwitcher({ sessions, activeSessionId, onSelect, onNew }: SessionSwitcherProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const active = sessions.find((s) => s.sessionId === activeSessionId)
  const activeTitle = active?.title ?? '本次会话'

  return (
    <div className="flex items-center gap-2">
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-card px-2.5 h-8 text-[13px] text-text-primary hover:bg-bg-card-hover transition-colors max-w-[260px]"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-text-muted">会话</span>
          <span className="truncate">{activeTitle}</span>
          <ChevronIcon className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>
        {open && (
          <div
            className="absolute left-0 top-9 z-20 w-[280px] max-h-80 overflow-y-auto rounded-xl border border-border bg-bg-card py-1 shadow-sm"
            role="listbox"
          >
            {sessions.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-text-muted">暂无历史会话</div>
            )}
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                role="option"
                aria-selected={s.sessionId === activeSessionId}
                onClick={() => {
                  setOpen(false)
                  if (s.sessionId !== activeSessionId) onSelect(s.sessionId)
                }}
                className={`block w-full text-left px-3 py-2 text-[13px] truncate hover:bg-bg-card-hover transition-colors ${
                  s.sessionId === activeSessionId ? 'text-accent-green-dim font-semibold' : 'text-text-secondary'
                }`}
              >
                {s.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onNew}
        className="inline-flex items-center gap-1 rounded-lg border border-accent-green/30 bg-accent-green/5 px-2.5 h-8 text-[12px] font-semibold text-accent-green-dim hover:bg-accent-green/10 transition-colors"
      >
        <PlusIcon />
        新会话
      </button>
    </div>
  )
}
