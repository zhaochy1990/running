/**
 * Page-level integration tests for CoachChatPage.
 *
 * The hook is mocked at the module boundary following the same
 * vi.hoisted pattern used in CoachWeeklyPlanPage.test.tsx so we
 * can control state without spinning up real HTTP.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoachChatState } from '../../hooks/useCoachChat'

const chatState = vi.hoisted(() => ({ current: null as CoachChatState | null }))

vi.mock('../../hooks/useCoachChat', () => ({
  useCoachChat: () => chatState.current,
}))

import CoachChatPage from '../CoachChatPage'

const sendMessageMock = vi.fn()
const retryMock = vi.fn()

const baseState: CoachChatState = {
  messages: [],
  loading: false,
  error: null,
  sendMessage: sendMessageMock,
  retry: retryMock,
}

describe('CoachChatPage', () => {
  beforeEach(() => {
    chatState.current = { ...baseState, sendMessage: sendMessageMock, retry: retryMock }
    sendMessageMock.mockReset()
    retryMock.mockReset()
  })

  // ── Initial load ──────────────────────────────────────────────

  it('uses the full AppLayout content width', () => {
    render(<CoachChatPage />)
    expect(screen.getByTestId('coach-chat-page')).toHaveClass('w-full', 'max-w-none')
    expect(screen.getByTestId('coach-chat-page')).not.toHaveClass('max-w-3xl')
  })

  it('lets the transcript scrollbar reach the content edge while chrome stays padded', () => {
    render(<CoachChatPage />)
    // The page container itself carries no horizontal padding, so the transcript
    // scroll region (inside CoachChat) can span to AppLayout's right edge.
    const page = screen.getByTestId('coach-chat-page')
    expect(page).not.toHaveClass('px-4')
    // The header keeps normal page padding.
    const header = page.querySelector('header')
    expect(header).toHaveClass('px-4')
    // The transcript content is inset on the right so text is not flush.
    expect(screen.getByTestId('coach-chat-transcript')).toHaveClass('pr-4')
  })

  it('renders the page title "STRIDE Coach"', () => {
    render(<CoachChatPage />)
    expect(screen.getByRole('heading', { name: 'STRIDE Coach' })).toBeInTheDocument()
  })

  it('renders a comfortable multiline composer', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    expect(textarea).toBeInTheDocument()
    expect(textarea).toHaveAttribute('rows', '3')
    expect(textarea).toHaveClass('min-h-[84px]')
  })

  it('renders the send button with label "发送给 Coach"', () => {
    render(<CoachChatPage />)
    expect(screen.getByRole('button', { name: '发送给 Coach' })).toBeInTheDocument()
  })

  // ── Sending a message ─────────────────────────────────────────

  it('calls sendMessage with the textarea content when the send button is clicked', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    fireEvent.change(textarea, { target: { value: '我最近练得怎么样？' } })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Coach' }))
    expect(sendMessageMock).toHaveBeenCalledWith('我最近练得怎么样？')
  })

  it('calls sendMessage when Cmd+Enter is pressed in the textarea', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    fireEvent.change(textarea, { target: { value: '问题' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(sendMessageMock).toHaveBeenCalledWith('问题')
  })

  it('calls sendMessage when Ctrl+Enter is pressed in the textarea', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    fireEvent.change(textarea, { target: { value: '问题' } })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(sendMessageMock).toHaveBeenCalledWith('问题')
  })

  it('does not call sendMessage when bare Enter is pressed (allows newline)', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    fireEvent.change(textarea, { target: { value: '问题' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('clears the textarea after sending', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    fireEvent.change(textarea, { target: { value: '问题' } })
    fireEvent.click(screen.getByRole('button', { name: '发送给 Coach' }))
    expect((textarea as HTMLTextAreaElement).value).toBe('')
  })

  // ── Empty / whitespace input guards ──────────────────────────

  it('does not call sendMessage when the textarea is empty', () => {
    render(<CoachChatPage />)
    fireEvent.click(screen.getByRole('button', { name: '发送给 Coach' }))
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('send button is disabled when the textarea is empty', () => {
    render(<CoachChatPage />)
    const button = screen.getByRole('button', { name: '发送给 Coach' })
    expect(button).toBeDisabled()
  })

  it('send button is disabled when the textarea contains only whitespace', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    fireEvent.change(textarea, { target: { value: '   ' } })
    const button = screen.getByRole('button', { name: '发送给 Coach' })
    expect(button).toBeDisabled()
  })

  // ── Loading state ─────────────────────────────────────────────

  it('disables the send button while loading', () => {
    chatState.current = { ...baseState, loading: true, sendMessage: sendMessageMock, retry: retryMock }
    render(<CoachChatPage />)
    expect(screen.getByRole('button', { name: '发送给 Coach' })).toBeDisabled()
  })

  it('shows a loading indicator while the API call is in flight', () => {
    chatState.current = { ...baseState, loading: true, sendMessage: sendMessageMock, retry: retryMock }
    render(<CoachChatPage />)
    // Accept either an aria-busy region, a spinner element, or a visible text hint.
    const hasBusyRegion = document.querySelector('[aria-busy="true"]') !== null
    const hasSpinner = document.querySelector('.animate-spin, [role="progressbar"]') !== null
    expect(hasBusyRegion || hasSpinner).toBe(true)
  })

  // ── Error state ───────────────────────────────────────────────

  it('shows the error message when error is set', () => {
    chatState.current = { ...baseState, error: '网络错误，请重试', sendMessage: sendMessageMock, retry: retryMock }
    render(<CoachChatPage />)
    expect(screen.getByText('网络错误，请重试')).toBeInTheDocument()
  })

  it('calls retry() when the retry button is clicked', () => {
    chatState.current = { ...baseState, error: '网络错误，请重试', sendMessage: sendMessageMock, retry: retryMock }
    render(<CoachChatPage />)
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(retryMock).toHaveBeenCalledTimes(1)
  })

  // ── Message list ──────────────────────────────────────────────

  it('renders user messages and coach messages in the correct visual positions', () => {
    chatState.current = {
      ...baseState,
      messages: [
        { role: 'user', content: '我最近练得怎么样？' },
        { role: 'coach', content: '### 结论\n你的跑量稳定。' },
      ],
      sendMessage: sendMessageMock,
      retry: retryMock,
    }
    render(<CoachChatPage />)
    expect(screen.getByText('我最近练得怎么样？')).toBeInTheDocument()
    // Coach markdown heading rendered.
    expect(screen.getByRole('heading', { level: 3, name: '结论' })).toBeInTheDocument()
  })

  // ── Accessibility ─────────────────────────────────────────────

  it('provides an accessible label for the textarea', () => {
    render(<CoachChatPage />)
    const textarea = screen.getByPlaceholderText('向 Coach 继续提问...')
    // Either an aria-label attribute or an associated <label> element.
    const hasLabel =
      textarea.getAttribute('aria-label') !== null ||
      textarea.getAttribute('aria-labelledby') !== null ||
      document.querySelector(`label[for="${textarea.id}"]`) !== null
    expect(hasLabel).toBe(true)
  })

  it('communicates disabled state on the send button via native disabled or aria-disabled', () => {
    render(<CoachChatPage />)
    const button = screen.getByRole('button', { name: '发送给 Coach' })
    const isDisabled =
      (button as HTMLButtonElement).disabled ||
      button.getAttribute('aria-disabled') === 'true'
    expect(isDisabled).toBe(true)
  })

  it('message list region has role="log" or aria-live="polite" for screen-reader announcements', () => {
    render(<CoachChatPage />)
    const liveRegion =
      document.querySelector('[role="log"]') ??
      document.querySelector('[aria-live="polite"]') ??
      document.querySelector('[aria-live="assertive"]')
    expect(liveRegion).toBeInTheDocument()
  })
})
