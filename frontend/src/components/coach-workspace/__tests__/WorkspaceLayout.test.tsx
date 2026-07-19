import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WorkspaceLayout } from '../WorkspaceLayout'

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
})
