import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

interface WorkspaceLayoutProps {
  /** Middle column: the current plan + proposal Review. */
  readonly children: ReactNode
  /** Right column: coach chat, anchored at the context anchor. */
  readonly chat: ReactNode
  /** Heading for the middle column. */
  readonly title: string
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
 */
export function WorkspaceLayout({ children, chat, title }: WorkspaceLayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)

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

  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-6 sm:px-8 lg:flex-row">
      <main className="min-w-0 flex-1" aria-label={title}>
        <div className="mb-4 flex items-center justify-between gap-3">
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
        {children}
      </main>

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
        className={[
          'shrink-0 border-border-subtle bg-bg-card',
          // wide: docked column
          'lg:static lg:z-auto lg:block lg:w-[360px] lg:rounded-lg lg:border',
          // narrow: full-height right drawer, toggled
          'fixed inset-y-0 right-0 z-50 w-[min(360px,90vw)] overflow-y-auto border-l',
          drawerOpen ? 'block' : 'hidden lg:block',
        ].join(' ')}
      >
        <div className="flex items-center justify-end p-2 lg:hidden">
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
        {chat}
      </aside>
    </div>
  )
}
