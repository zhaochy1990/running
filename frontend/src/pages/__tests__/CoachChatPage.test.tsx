import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyCoachMasterDiff,
  applyCoachWeekDiff,
  getCoachThread,
  getStrideTrainingLoad,
  sendCoachChat,
  type CoachChatResponse,
  type CoachProposalCard,
} from '../../api'
import { UserContext } from '../../UserContextValue'
import CoachChatPage from '../CoachChatPage'

// Keep pure helpers (isWeekDiff) real; mock only the network calls.
vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    getCoachThread: vi.fn(),
    getStrideTrainingLoad: vi.fn(),
    sendCoachChat: vi.fn(),
    applyCoachWeekDiff: vi.fn(),
    applyCoachMasterDiff: vi.fn(),
  }
})

function renderPage() {
  return render(
    <UserContext.Provider value={{ user: 'test-user', displayName: 'Tester', refresh: async () => {} }}>
      <CoachChatPage />
    </UserContext.Provider>,
  )
}

function chatResult(partial: Partial<CoachChatResponse>): { ok: true; status: number; data: CoachChatResponse } {
  return {
    ok: true,
    status: 200,
    data: {
      session_id: 's1',
      thread_id: 'test-user:coach:s1',
      reply: '',
      clarification: null,
      active_target: null,
      proposals: [],
      ...partial,
    },
  }
}

const weekProposal: CoachProposalCard = {
  specialist_id: 'weekly_plan',
  target: { kind: 'week', folder: '2026-06-23_06-29' },
  summary: '把周二间歇移到今天',
  proposal: {
    diff_id: 'd1',
    folder: '2026-06-23_06-29',
    ai_explanation: '明天有雨，今天先把强度课做了。',
    created_at: '2026-06-23T00:00:00Z',
    ops: [
      {
        id: 'op1',
        op: 'move_session',
        date: '2026-06-24',
        session_index: 0,
        old_value: { summary: '周二 800m×6 间歇' },
        new_value: { summary: '今天 (周一)' },
        spec_patch: { new_date: '2026-06-23' },
        accepted: null,
      },
    ],
  },
}

async function sendMessage(text: string) {
  const textarea = await screen.findByLabelText('给教练的消息')
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.click(screen.getByLabelText('发送'))
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(getCoachThread).mockResolvedValue({
    thread_id: 'test-user:coach:s1',
    user_id: 'test-user',
    scope: 'coach',
    key: 's1',
    messages: [],
  })
  vi.mocked(getStrideTrainingLoad).mockResolvedValue({ current: null, series: [] })
})

describe('CoachChatPage', () => {
  it('renders the coach reply after sending a message', async () => {
    vi.mocked(sendCoachChat).mockResolvedValue(chatResult({ reply: '你最近状态不错，可以加一点强度。' }))
    renderPage()
    await sendMessage('今天能上强度吗')
    // Appears in the user bubble and (as the session title) in the switcher.
    expect((await screen.findAllByText('今天能上强度吗')).length).toBeGreaterThan(0)
    expect(await screen.findByText(/你最近状态不错/)).toBeInTheDocument()
  })

  it('renders a proposal card and enters review mode on 展开审阅', async () => {
    vi.mocked(sendCoachChat).mockResolvedValue(
      chatResult({ reply: '好的，这会把周二间歇移到今天。', proposals: [weekProposal] }),
    )
    renderPage()
    await sendMessage('把明天的间歇课挪到今天')
    const reviewBtn = await screen.findByRole('button', { name: '展开审阅' })
    fireEvent.click(reviewBtn)
    expect(await screen.findByText(/提案审阅/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /采纳所选/ })).toBeInTheDocument()
  })

  it('applies a week proposal via the week endpoint (not master)', async () => {
    vi.mocked(sendCoachChat).mockResolvedValue(chatResult({ reply: '提案如下。', proposals: [weekProposal] }))
    vi.mocked(applyCoachWeekDiff).mockResolvedValue({
      ok: true,
      status: 200,
      data: { applied: 1, folder: '2026-06-23_06-29', updated_at: '2026-06-23T01:00:00Z' },
    })
    renderPage()
    await sendMessage('挪课')
    fireEvent.click(await screen.findByRole('button', { name: '展开审阅' }))
    fireEvent.click(await screen.findByRole('button', { name: /采纳所选/ }))
    await waitFor(() => expect(applyCoachWeekDiff).toHaveBeenCalledTimes(1))
    expect(applyCoachWeekDiff).toHaveBeenCalledWith('2026-06-23_06-29', weekProposal.proposal, ['op1'])
    expect(applyCoachMasterDiff).not.toHaveBeenCalled()
    expect(await screen.findByText(/已应用 1 项/)).toBeInTheDocument()
  })

  it('shows a clarification prompt and no proposal card', async () => {
    vi.mocked(sendCoachChat).mockResolvedValue(
      chatResult({
        reply: '',
        clarification: '你指的是本周还是下周的间歇课？',
        proposals: [weekProposal], // page must drop these when clarification is set
      }),
    )
    renderPage()
    await sendMessage('挪一下间歇课')
    expect(await screen.findByText('需要澄清')).toBeInTheDocument()
    expect(screen.getByText(/本周还是下周/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '展开审阅' })).not.toBeInTheDocument()
  })

  it('keeps the locked active_target across a later read-only turn', async () => {
    vi.mocked(sendCoachChat)
      .mockResolvedValueOnce(
        chatResult({
          reply: '已生成本周调整提案。',
          active_target: { kind: 'week', folder: '2026-06-29_07-05' },
        }),
      )
      // A status/Q&A turn returns active_target=null — must NOT clear the dock.
      .mockResolvedValueOnce(chatResult({ reply: '你状态还行。', active_target: null }))
    renderPage()
    await sendMessage('帮我调整这周')
    expect(await screen.findByText('2026-06-29_07-05')).toBeInTheDocument()
    await sendMessage('那我状态怎么样')
    expect(await screen.findByText(/你状态还行/)).toBeInTheDocument()
    // Target stays locked; dock does not fall back to the empty state.
    expect(screen.getByText('2026-06-29_07-05')).toBeInTheDocument()
    expect(screen.queryByText('尚未锁定对象')).not.toBeInTheDocument()
  })

  it('shows an error message when the coach is unavailable (503)', async () => {
    vi.mocked(sendCoachChat).mockResolvedValue({
      ok: false,
      status: 503,
      data: {} as CoachChatResponse,
    })
    renderPage()
    await sendMessage('状态如何')
    expect(await screen.findByText(/AI 教练当前不可用/)).toBeInTheDocument()
  })
})
