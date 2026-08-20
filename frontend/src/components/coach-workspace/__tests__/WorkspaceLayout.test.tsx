import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceLayout } from '../WorkspaceLayout'

/** Helper: stub window.matchMedia so useIsDesktop() returns `matches`. */
function mockMatchMedia(matches: boolean) {
  const mq = {
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mq))
  return mq
}

// Default: simulate desktop (lg+) for all tests unless overridden.
beforeEach(() => {
  mockMatchMedia(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderLayout() {
  return render(
    <WorkspaceLayout title="调整本周计划" chat={<div data-testid="chat-panel">chat</div>}>
      <div>review body</div>
    </WorkspaceLayout>,
  )
}

describe('WorkspaceLayout', () => {
  it('renders the review body and titled main region', () => {
    renderLayout()
    expect(screen.getByText('review body')).toBeInTheDocument()
    expect(screen.getByRole('main', { name: '调整本周计划' })).toBeInTheDocument()
  })

  it('mounts the chat node exactly once', () => {
    renderLayout()
    expect(screen.getAllByTestId('chat-panel')).toHaveLength(1)
  })

  it('keeps review and chat in independent scroll regions on desktop', () => {
    renderLayout()
    expect(screen.getByTestId('coach-workspace-shell')).toHaveClass('lg:overflow-hidden')
    expect(screen.getByTestId('coach-workspace-review-scroll')).toHaveClass(
      'lg:overflow-y-auto',
    )
    expect(screen.getByTestId('coach-workspace-chat-scroll')).toHaveClass(
      'min-h-0',
      'flex-1',
    )
  })

  it('spans the full content width on desktop (chat aside hugs the right edge)', () => {
    renderLayout()
    const shell = screen.getByTestId('coach-workspace-shell')
    expect(shell).toHaveClass('w-full', 'max-w-none', 'lg:pr-0')
    expect(shell).not.toHaveClass('mx-auto')
    expect(shell.className).not.toMatch(/max-w-\[\d+px\]/)
  })

  it('labels the docked chat as a complementary region', () => {
    renderLayout()
    expect(screen.getByRole('complementary', { name: 'Coach 对话' })).toBeInTheDocument()
  })

  it('opens an accessible modal drawer, traps focus, and restores focus on Escape', () => {
    renderLayout()
    const openBtn = screen.getByRole('button', { name: '打开 Coach 对话' })
    openBtn.focus()
    expect(openBtn).toHaveAttribute('aria-expanded', 'false')
    expect(openBtn).toHaveAttribute('aria-controls', 'coach-chat-panel')

    fireEvent.click(openBtn)
    expect(openBtn).toHaveAttribute('aria-expanded', 'true')
    const dialog = screen.getByRole('dialog', { name: 'Coach 对话' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const closeBtn = screen.getByRole('button', { name: '关闭 Coach 对话' })
    expect(closeBtn).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(openBtn).toHaveAttribute('aria-expanded', 'false')
    expect(openBtn).toHaveFocus()
    expect(screen.getAllByTestId('chat-panel')).toHaveLength(1)
  })

  describe('resizable divider (desktop lg+)', () => {
    let localStorageMock: Record<string, string>

    beforeEach(() => {
      localStorageMock = {}
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
        (key) => localStorageMock[key] ?? null,
      )
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
        localStorageMock[key] = value
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('renders the ARIA separator with correct roles and attributes', () => {
      renderLayout()
      const divider = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      expect(divider).toBeInTheDocument()
      expect(divider).toHaveAttribute('aria-orientation', 'vertical')
      expect(divider).toHaveAttribute('aria-controls', 'coach-chat-panel')
      expect(divider).toHaveAttribute('tabindex', '0')
      // Chat is the primary pane controlled by the separator, so valuenow is its width.
      expect(divider).toHaveAttribute('aria-valuenow')
      expect(divider).toHaveAttribute('aria-valuetext', 'Coach 对话宽度 30%')
      expect(divider).toHaveAttribute('aria-valuemin')
      expect(divider).toHaveAttribute('aria-valuemax')
    })

    it('ArrowLeft increases chat width (divider moves left)', () => {
      renderLayout()
      const divider = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      const initialValue = Number(divider.getAttribute('aria-valuenow'))
      fireEvent.keyDown(divider, { key: 'ArrowLeft' })
      const afterValue = Number(divider.getAttribute('aria-valuenow'))
      expect(afterValue).toBeGreaterThan(initialValue)
    })

    it('ArrowRight decreases chat width (divider moves right)', () => {
      renderLayout()
      const divider = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      const initialValue = Number(divider.getAttribute('aria-valuenow'))
      fireEvent.keyDown(divider, { key: 'ArrowRight' })
      const afterValue = Number(divider.getAttribute('aria-valuenow'))
      expect(afterValue).toBeLessThan(initialValue)
    })

    it('Home resets chat to minimum width', () => {
      renderLayout()
      const divider = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      fireEvent.keyDown(divider, { key: 'Home' })
      const value = Number(divider.getAttribute('aria-valuenow'))
      const min = Number(divider.getAttribute('aria-valuemin'))
      expect(value).toBe(min)
    })

    it('End sets chat to maximum width', () => {
      renderLayout()
      const divider = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      fireEvent.keyDown(divider, { key: 'End' })
      const value = Number(divider.getAttribute('aria-valuenow'))
      const max = Number(divider.getAttribute('aria-valuemax'))
      expect(value).toBe(max)
    })

    it('persists chat width to localStorage and restores it', () => {
      const { unmount } = renderLayout()
      const divider = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      fireEvent.keyDown(divider, { key: 'ArrowLeft' })
      const savedValue = Number(divider.getAttribute('aria-valuenow'))
      unmount()

      // Re-render — should pick up stored value
      renderLayout()
      const divider2 = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      expect(Number(divider2.getAttribute('aria-valuenow'))).toBe(savedValue)
    })

    it('clamps chat width within [min, max] range on pointer drag', () => {
      renderLayout()
      const divider = screen.getByRole('separator', { name: /调整 Coach 对话宽度/ })
      const min = Number(divider.getAttribute('aria-valuemin'))
      const max = Number(divider.getAttribute('aria-valuemax'))

      // Simulate pointer down on the divider then extreme pointer move
      fireEvent.pointerDown(divider, { clientX: 800, pointerId: 1 })
      // Move far left (should clamp to max)
      fireEvent.pointerMove(document, { clientX: 0 })
      let value = Number(divider.getAttribute('aria-valuenow'))
      expect(value).toBeLessThanOrEqual(max)
      expect(value).toBeGreaterThanOrEqual(min)
      fireEvent.pointerUp(document)

      // Move far right (should clamp to min)
      fireEvent.pointerDown(divider, { clientX: 200, pointerId: 1 })
      fireEvent.pointerMove(document, { clientX: 9999 })
      value = Number(divider.getAttribute('aria-valuenow'))
      expect(value).toBeLessThanOrEqual(max)
      expect(value).toBeGreaterThanOrEqual(min)
      fireEvent.pointerUp(document)
    })

    it('does not apply inline width style on mobile (drawer keeps its own width)', () => {
      // Simulate mobile viewport — matchMedia returns matches=false
      mockMatchMedia(false)
      renderLayout()
      const aside = document.getElementById('coach-chat-panel')
      expect(aside).toBeTruthy()
      // No inline width should be set when not on desktop
      expect(aside!.style.width).toBe('')
    })

    it('applies inline width style on desktop', () => {
      // Simulate desktop viewport — matchMedia returns matches=true
      mockMatchMedia(true)
      renderLayout()
      const aside = document.getElementById('coach-chat-panel')
      expect(aside).toBeTruthy()
      expect(aside!.style.width).not.toBe('')
    })
  })
})
