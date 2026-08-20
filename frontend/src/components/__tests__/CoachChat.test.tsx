/**
 * Behavioral tests for the CoachChat panel: proposal rendering (single /
 * multi with a "选择一个调整方案" heading / active-target-only intake entry)
 * and debug-only tool message visibility.
 *
 * The hook and user context are mocked at the module boundary so we can drive
 * state directly.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CoachChatState } from '../../hooks/useCoachChat'
import type { UserContextType } from '../../UserContextValue'

const chatState = vi.hoisted(() => ({ current: null as CoachChatState | null }))
const userState = vi.hoisted(() => ({ current: null as UserContextType | null }))

vi.mock('../../hooks/useCoachChat', () => ({
  useCoachChat: () => chatState.current,
}))
vi.mock('../../UserContextValue', () => ({
  useUser: () => userState.current,
}))

// The upgrade card is exercised by its own test; stub it so we can count cards.
vi.mock('../CoachProposalUpgradeCard', () => ({
  default: ({
    proposal,
    activeTarget,
    contextAnchor,
  }: {
    proposal?: unknown
    activeTarget?: unknown
    contextAnchor?: string
  }) => (
    <div
      data-testid="upgrade-card"
      data-kind={proposal ? 'proposal' : activeTarget ? 'active' : 'none'}
      data-context-anchor={contextAnchor}
    />
  ),
}))

import CoachChat from '../CoachChat'

const sendMessageMock = vi.fn()
const retryMock = vi.fn()

const baseChat: CoachChatState = {
  messages: [],
  loading: false,
  error: null,
  sendMessage: sendMessageMock,
  retry: retryMock,
  proposals: [],
  activeTarget: null,
  historyLoading: false,
  historyError: null,
  reloadHistory: vi.fn(),
}

const baseUser: UserContextType = {
  user: 'user-1',
  displayName: 'A',
  profileReady: true,
  coachChat: true,
  coachChatDebug: false,
  refresh: async () => {},
}

function renderChat() {
  return render(
    <MemoryRouter>
      <CoachChat />
    </MemoryRouter>,
  )
}

function makeProposal(summary: string) {
  return {
    specialist_id: 'week',
    summary,
    target: { kind: 'week' as const, folder: '2026-07-13_07-19' },
    proposal: { folder: '2026-07-13_07-19', ops: [] },
    base_revision: 'rev',
    season_impact: null,
  }
}

describe('CoachChat — proposals', () => {
  beforeEach(() => {
    chatState.current = { ...baseChat }
    userState.current = { ...baseUser }
    sendMessageMock.mockReset()
    retryMock.mockReset()
  })

  it('renders a single proposal card without the multi-select heading', () => {
    chatState.current = { ...baseChat, proposals: [makeProposal('本周降量')] }
    renderChat()
    const card = screen.getByTestId('upgrade-card')
    expect(card).toBeInTheDocument()
    expect(card.closest('[role="log"]')).toBeNull()
    expect(screen.queryByText('选择一个调整方案')).not.toBeInTheDocument()
  })

  it('keeps a pending proposal anchored to the turn that produced it', () => {
    chatState.current = {
      ...baseChat,
      messages: [
        { role: 'coach', content: '已生成方案', messageId: 'proposal-message' },
        { role: 'coach', content: '这是后续说明', messageId: 'follow-up-message' },
      ],
      proposals: [makeProposal('本周降量')],
      proposalContextAnchor: 'proposal-message',
    }
    renderChat()
    expect(screen.getByTestId('upgrade-card')).toHaveAttribute(
      'data-context-anchor',
      'proposal-message',
    )
  })

  it('renders all proposal cards and a "选择一个调整方案" heading when multiple', () => {
    chatState.current = {
      ...baseChat,
      proposals: [makeProposal('方案 A'), makeProposal('方案 B'), makeProposal('方案 C')],
    }
    renderChat()
    expect(screen.getAllByTestId('upgrade-card')).toHaveLength(3)
    expect(screen.getByText('选择一个调整方案')).toBeInTheDocument()
  })

  it('renders an intake entry card from an active target when there is no proposal', () => {
    chatState.current = {
      ...baseChat,
      proposals: [],
      activeTarget: { kind: 'week', folder: '2026-07-13_07-19' },
    }
    renderChat()
    const cards = screen.getAllByTestId('upgrade-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toHaveAttribute('data-kind', 'active')
  })

  it('shows no upgrade card when there is neither a proposal nor an active target', () => {
    renderChat()
    expect(screen.queryByTestId('upgrade-card')).not.toBeInTheDocument()
  })
})

describe('CoachChat — layout', () => {
  beforeEach(() => {
    chatState.current = { ...baseChat }
    userState.current = { ...baseUser }
  })

  it('keeps the tight column padding by default (docked workspace aside)', () => {
    renderChat()
    const transcript = screen.getByTestId('coach-chat-transcript')
    expect(transcript).toHaveClass('px-1')
    expect(transcript).not.toHaveClass('pr-4')
  })

  it('insets content but frees the scrollbar in edgeToEdge (full-page) mode', () => {
    render(
      <MemoryRouter>
        <CoachChat edgeToEdge />
      </MemoryRouter>,
    )
    const transcript = screen.getByTestId('coach-chat-transcript')
    expect(transcript).not.toHaveClass('px-1')
    expect(transcript).toHaveClass('pl-4', 'pr-4')
  })
})

describe('CoachChat — history state', () => {  beforeEach(() => {
    userState.current = { ...baseUser }
    sendMessageMock.mockReset()
    retryMock.mockReset()
  })

  it('announces the initial history loading state', () => {
    chatState.current = { ...baseChat, historyLoading: true }
    renderChat()
    expect(screen.getByText('加载对话历史中…')).toBeInTheDocument()
  })
})

describe('CoachChat — event receipts', () => {
  beforeEach(() => {
    userState.current = { ...baseUser }
    sendMessageMock.mockReset()
    retryMock.mockReset()
  })

  it('renders trusted event receipts for normal (non-debug) users', () => {
    userState.current = { ...baseUser, coachChatDebug: false }
    chatState.current = {
      ...baseChat,
      messages: [
        { role: 'user', content: '降量' },
        {
          role: 'event',
          content: '已启用本周课表调整',
          eventStatus: 'applied',
          messageId: 'ev1',
        },
      ],
    }
    renderChat()
    const bar = document.querySelector('[data-role="event"]')
    expect(bar).toBeInTheDocument()
    expect(bar).toHaveAttribute('data-status', 'applied')
    expect(screen.getByText('已启用本周课表调整')).toBeInTheDocument()
  })
})

describe('CoachChat — debug tool visibility', () => {
  beforeEach(() => {
    chatState.current = {
      ...baseChat,
      messages: [
        { role: 'user', content: '问' },
        { role: 'tool', content: 'RAW TOOL OUTPUT', toolName: 'search' },
        { role: 'coach', content: '答' },
      ],
    }
    userState.current = { ...baseUser }
    sendMessageMock.mockReset()
    retryMock.mockReset()
  })

  it('hides raw tool messages for non-debug users', () => {
    userState.current = { ...baseUser, coachChatDebug: false }
    renderChat()
    expect(screen.queryByText('RAW TOOL OUTPUT')).not.toBeInTheDocument()
  })

  it('shows raw tool messages for debug users', () => {
    userState.current = { ...baseUser, coachChatDebug: true }
    renderChat()
    expect(screen.getByText('RAW TOOL OUTPUT')).toBeInTheDocument()
  })
})
