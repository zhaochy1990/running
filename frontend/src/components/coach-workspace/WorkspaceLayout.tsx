import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'

/** Returns true when the viewport is at least the Tailwind `lg` breakpoint (1024 px). */
function useIsDesktop(): boolean {
  const canMatch =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const [isDesktop, setIsDesktop] = useState(
    () => canMatch && window.matchMedia('(min-width: 1024px)').matches,
  )
  useEffect(() => {
    if (!canMatch) return undefined
    const mq = window.matchMedia('(min-width: 1024px)')
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [canMatch])
  return isDesktop
}

interface WorkspaceLayoutProps {
  /** Middle column: the current plan + proposal Review. */
  readonly children: ReactNode
  /** Right column: coach chat, anchored at the context anchor. */
  readonly chat: ReactNode
  /** Heading for the middle column. */
  readonly title: string
}

/** Chat column width as percentage of the two-column area (review + chat). */
const CHAT_WIDTH_MIN_PCT = 20
const CHAT_WIDTH_MAX_PCT = 60
const CHAT_WIDTH_DEFAULT_PCT = 30
const KEYBOARD_STEP_PCT = 2
const LS_KEY = 'workspace-chat-width-pct'

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw !== null) {
      const parsed = Number(raw)
      if (
        Number.isFinite(parsed) &&
        parsed >= CHAT_WIDTH_MIN_PCT &&
        parsed <= CHAT_WIDTH_MAX_PCT
      ) {
        return parsed
      }
    }
  } catch {
    // localStorage unavailable — ignore
  }
  return CHAT_WIDTH_DEFAULT_PCT
}

function saveWidth(pct: number) {
  try {
    localStorage.setItem(LS_KEY, String(pct))
  } catch {
    // ignore write errors
  }
}

/**
 * Three-column adjust workspace shell. The left column (global nav) is provided
 * by the surrounding AppLayout route; this renders the middle (review) and
 * right (chat) columns.
 *
 * The chat node is mounted exactly once — a single `<aside>` that is a docked
 * side column on wide screens and a full-height overlay drawer (button-toggled)
 * on narrow screens. Mounting it once keeps any chat hook state intact rather
 * than splitting it across two DOM copies.
 *
 * On desktop (lg+) a draggable vertical separator sits between review and chat.
 * It supports Pointer Events for mouse/touch drag and keyboard navigation
 * (ArrowLeft / ArrowRight / Home / End). Width preference is persisted in
 * localStorage.
 */
export function WorkspaceLayout({ children, chat, title }: WorkspaceLayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [chatWidthPct, setChatWidthPct] = useState<number>(readStoredWidth)

  const openButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)

  // Drag state — held in a ref so pointermove handler is always current
  const dragRef = useRef<{ active: boolean; startX: number; startPct: number }>({
    active: false,
    startX: 0,
    startPct: CHAT_WIDTH_DEFAULT_PCT,
  })

  useEffect(() => {
    if (drawerOpen) closeButtonRef.current?.focus()
  }, [drawerOpen])

  const closeDrawer = () => {
    setDrawerOpen(false)
    openButtonRef.current?.focus()
  }

  const handleDrawerKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDrawer()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    )
    if (focusable.length === 0) {
      event.preventDefault()
      panelRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  // ----- Divider keyboard handler -----
  const handleDividerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
        // WAI-ARIA Window Splitter: move the separator physically left,
        // expanding the controlled pane on its right (the Coach chat).
        next = chatWidthPct + KEYBOARD_STEP_PCT
        break
      case 'ArrowRight':
        next = chatWidthPct - KEYBOARD_STEP_PCT
        break
      case 'Home':
        next = CHAT_WIDTH_MIN_PCT
        break
      case 'End':
        next = CHAT_WIDTH_MAX_PCT
        break
      default:
        return
    }
    event.preventDefault()
    const clamped = Math.min(CHAT_WIDTH_MAX_PCT, Math.max(CHAT_WIDTH_MIN_PCT, next))
    setChatWidthPct(clamped)
    saveWidth(clamped)
  }

  // ----- Pointer drag handlers -----
  const handleDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // setPointerCapture may be absent in test environments (jsdom)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { active: true, startX: event.clientX, startPct: chatWidthPct }
  }

  const handlePointerMove = useCallback(
    (event: globalThis.PointerEvent) => {
      if (!dragRef.current.active) return
      const shell = shellRef.current
      if (!shell) return

      const shellWidth = shell.getBoundingClientRect().width
      if (shellWidth === 0) return

      const deltaX = event.clientX - dragRef.current.startX
      // Moving left → delta negative → chat grows (pct increases)
      const deltaPct = (-deltaX / shellWidth) * 100
      const next = dragRef.current.startPct + deltaPct
      const clamped = Math.min(CHAT_WIDTH_MAX_PCT, Math.max(CHAT_WIDTH_MIN_PCT, next))
      setChatWidthPct(clamped)
    },
    [],
  )

  const handlePointerUp = useCallback(() => {
    if (!dragRef.current.active) return
    dragRef.current.active = false
    // Persist final width
    setChatWidthPct((prev) => {
      saveWidth(prev)
      return prev
    })
  }, [])

  useEffect(() => {
    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  const chatWidthRounded = Math.round(chatWidthPct)

  // Apply width only on desktop (≥1024 px) so the mobile fixed-drawer width is
  // not overridden. A media query listener avoids touching the DOM on every render.
  const isDesktop = useIsDesktop()

  return (
    <div
      ref={shellRef}
      data-testid="coach-workspace-shell"
      className="flex h-full min-h-0 w-full max-w-none flex-col gap-6 px-4 py-6 sm:px-8 lg:flex-row lg:overflow-hidden lg:pl-8 lg:pr-0"
    >
      <main
        className="flex min-h-0 min-w-0 flex-1 flex-col lg:h-full"
        aria-label={title}
      >
        <div className="mb-4 flex flex-shrink-0 items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-text-primary">{title}</h1>
          {/* Narrow-screen chat toggle. Hidden on wide screens where the aside docks. */}
          <button
            ref={openButtonRef}
            type="button"
            className="rounded-lg border border-border-subtle px-3 py-1.5 text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-green lg:hidden"
            aria-label="打开 Coach 对话"
            aria-expanded={drawerOpen}
            aria-controls="coach-chat-panel"
            onClick={() => setDrawerOpen(true)}
          >
            Coach 对话
          </button>
        </div>
        <div
          data-testid="coach-workspace-review-scroll"
          className="min-h-0 flex-1 lg:overflow-y-auto lg:pr-2"
        >
          {children}
        </div>
      </main>

      {/*
        Draggable vertical divider — only visible and functional on lg+ desktop.
        ARIA role="separator" with valuenow / valuemin / valuemax expresses the
        current chat column width as a percentage.
      */}
      <div
        role="separator"
        aria-label="调整 Coach 对话宽度"
        aria-orientation="vertical"
        aria-controls="coach-chat-panel"
        aria-valuenow={chatWidthRounded}
        aria-valuetext={`Coach 对话宽度 ${chatWidthRounded}%`}
        aria-valuemin={CHAT_WIDTH_MIN_PCT}
        aria-valuemax={CHAT_WIDTH_MAX_PCT}
        tabIndex={0}
        className="hidden cursor-col-resize touch-none select-none items-center justify-center lg:flex lg:w-1.5 lg:shrink-0"
        onKeyDown={handleDividerKeyDown}
        onPointerDown={handleDividerPointerDown}
      >
        {/* Visual drag handle */}
        <div className="h-12 w-1 rounded-full bg-border-subtle transition-colors hover:bg-accent-green focus-within:bg-accent-green" />
      </div>

      {/* Narrow-screen scrim behind the drawer. */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          aria-hidden
          onClick={closeDrawer}
        />
      )}

      {/*
        Single chat instance. Docked side column on lg+; on narrow screens it is
        a modal, full-height right drawer while `drawerOpen`.
      */}
      <aside
        ref={panelRef}
        id="coach-chat-panel"
        role={drawerOpen ? 'dialog' : 'complementary'}
        aria-modal={drawerOpen ? 'true' : undefined}
        aria-label="Coach 对话"
        tabIndex={drawerOpen ? -1 : undefined}
        onKeyDown={drawerOpen ? handleDrawerKeyDown : undefined}
        // Only apply width override on desktop; on mobile the drawer keeps w-[min(360px,90vw)].
        style={
          isDesktop
            ? {
                width: `${chatWidthPct}%`,
                minWidth: `${CHAT_WIDTH_MIN_PCT}%`,
                maxWidth: `${CHAT_WIDTH_MAX_PCT}%`,
              }
            : undefined
        }
        className={[
          'min-h-0 shrink-0 flex-col overflow-hidden border-border-subtle bg-bg-card',
          // wide: docked column with its own transcript scroll region (width driven by inline style on desktop)
          'lg:static lg:z-auto lg:flex lg:h-full lg:rounded-lg lg:border',
          // narrow: full-height right drawer, toggled; inline style is absent so w-[min(360px,90vw)] applies
          'fixed inset-y-0 right-0 z-50 w-[min(360px,90vw)] border-l',
          drawerOpen ? 'flex' : 'hidden lg:flex',
        ].join(' ')}
      >
        <div className="flex flex-shrink-0 items-center justify-end p-2 lg:hidden">
          <button
            ref={closeButtonRef}
            type="button"
            className="rounded-lg px-2 py-1 text-sm font-medium text-text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-green"
            aria-label="关闭 Coach 对话"
            onClick={closeDrawer}
          >
            关闭
          </button>
        </div>
        <div
          data-testid="coach-workspace-chat-scroll"
          className="min-h-0 flex-1 overflow-hidden"
        >
          {chat}
        </div>
      </aside>
    </div>
  )
}
