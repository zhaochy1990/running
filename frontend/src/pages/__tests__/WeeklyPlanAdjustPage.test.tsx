import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WeeklyPlanAdjustView } from '../WeeklyPlanAdjustPage'
import type { CoachApplyOutcome } from '../../api'
import type {
  StashedProposal,
  WeeklyCreateProposal,
  WeeklyDiffProposal,
  WeeklyProposal,
} from '../../components/coach-workspace/types'
import type { CoachReviewContext } from '../../types/coachChat'

const proposal: WeeklyDiffProposal = {
  proposalType: 'weekly_diff',
  summary: '把周三改成节奏跑',
  baseRevision: 'rev-abc',
  changes: [{ opId: 'op-1', label: '周三', changeType: 'update', oldValue: '5:30', newValue: '5:00' }],
  seasonImpact: null,
}

function stash(overrides: Partial<StashedProposal<WeeklyProposal>> = {}): StashedProposal<WeeklyProposal> {
  return {
    target: { userId: 'u1', kind: 'weekly', folder: 'W1' },
    contextAnchor: 'msg-7',
    proposal,
    rawProposal: { folder: 'W1', ops: [{ id: 'op-1' }] },
    ...overrides,
  }
}

interface Deps {
  readStash: ReturnType<typeof vi.fn>
  clearStash: ReturnType<typeof vi.fn>
  clearPendingTurnForWeek: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  abandon: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
  renderChat: ReturnType<typeof vi.fn>
}

function renderView(
  stashed: StashedProposal<WeeklyProposal> | null,
  applyImpl?: () => Promise<CoachApplyOutcome>,
): Deps {
  const readStash = vi.fn(() => stashed)
  const clearStash = vi.fn()
  const clearPendingTurnForWeek = vi.fn()
  const apply = vi.fn<
    (
      folder: string,
      rawProposal: Readonly<Record<string, unknown>>,
      opIds: readonly string[],
      baseRevision: string,
      impactAck?: string,
    ) => Promise<CoachApplyOutcome>
  >(applyImpl ?? (async () => ({ status: 'ok' }) as CoachApplyOutcome))
  const abandon = vi.fn(async () => {})
  const navigate = vi.fn()
  const renderChat = vi.fn(
    (anchor: string, reviewContext?: CoachReviewContext) => (
      <div
        data-testid="chat"
        data-anchor={anchor}
        data-has-review={reviewContext ? 'yes' : 'no'}
      >
        chat
      </div>
    ),
  )
  render(
    <WeeklyPlanAdjustView
      userId="u1"
      folder="W1"
      readStash={readStash}
      clearStash={clearStash}
      clearPendingTurnForWeek={clearPendingTurnForWeek}
      apply={apply}
      abandon={abandon}
      navigate={navigate}
      currentPlanSummary="本周课表 · W1"
      renderChat={renderChat}
    />,
  )
  return {
    readStash,
    clearStash,
    clearPendingTurnForWeek,
    apply,
    abandon,
    navigate,
    renderChat,
  }
}

const createProposal: WeeklyCreateProposal = {
  proposalType: 'weekly_create',
  summary: '创建本周计划',
  baseRevision: 'rev-create',
  opIds: ['op-1'],
  days: [{ label: '周一', detail: '休息' }],
  strength: [],
  nutrition: [],
  notesMd: null,
}

describe('WeeklyPlanAdjustView', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the intake state with no apply CTA when there is no stash', () => {
    renderView(null)
    expect(screen.getByText(/告诉 Coach/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '启用计划' })).not.toBeInTheDocument()
  })

  it('reviews and applies the stashed proposal, then navigates back with success state', async () => {
    const { apply, clearStash, clearPendingTurnForWeek, navigate } = renderView(stash())
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    // apply gets folder, raw proposal, op ids, base revision
    expect(apply.mock.calls[0][0]).toBe('W1')
    expect(apply.mock.calls[0][1]).toEqual({ folder: 'W1', ops: [{ id: 'op-1' }] })
    expect(apply.mock.calls[0][2]).toEqual(['op-1'])
    expect(apply.mock.calls[0][3]).toBe('rev-abc')
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/week/W1', { coachPlanApplied: true }))
    expect(clearPendingTurnForWeek).toHaveBeenCalledWith('W1')
    expect(clearStash).toHaveBeenCalled()
  })

  it('passes the context anchor to the chat', () => {
    renderView(stash())
    expect(screen.getByTestId('chat')).toHaveAttribute('data-anchor', 'msg-7')
  })

  it('anchors the chat to a weekly_create draft as review context', () => {
    const { renderChat } = renderView(
      stash({
        proposal: createProposal,
        rawProposal: { folder: 'W1', plan: { week_folder: 'W1' } },
      }),
    )
    expect(screen.getByTestId('chat')).toHaveAttribute('data-has-review', 'yes')
    const reviewContext = renderChat.mock.calls[0][1] as CoachReviewContext
    expect(reviewContext.kind).toBe('weekly_create')
    expect(reviewContext.proposal).toEqual({ folder: 'W1', plan: { week_folder: 'W1' } })
  })

  it('sends no review context for a weekly_diff proposal', () => {
    renderView(stash())
    expect(screen.getByTestId('chat')).toHaveAttribute('data-has-review', 'no')
  })

  it('sends no review context when the draft folder does not match the target week', () => {
    renderView(
      stash({
        proposal: createProposal,
        rawProposal: { folder: 'W2', plan: { week_folder: 'W2' } },
      }),
    )
    expect(screen.getByTestId('chat')).toHaveAttribute('data-has-review', 'no')
  })

  it('surfaces the season-impact gate on a needs_ack outcome', async () => {
    let call = 0
    const { apply } = renderView(stash(), async () => {
      call += 1
      return call === 1
        ? { status: 'needs_ack', seasonImpact: '会挤压下周长距离' }
        : { status: 'ok' }
    })
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(screen.getByText('会挤压下周长距离')).toBeInTheDocument())
    // apply blocked until the acknowledgement is checked
    const applyBtn = screen.getByRole('button', { name: '启用计划' })
    expect(applyBtn).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /仍只调整本周/ }))
    fireEvent.click(applyBtn)
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))
    // second call carries the acknowledgement
    expect(apply.mock.calls[1][4]).toBe('weekly_only')
  })

  it('re-reads the stash and swaps the Review when the refresh token changes', () => {
    // A revised weekly-create draft replaces the diff on screen when the coach
    // re-stashes it for the same route (task #30). The token change is what
    // forces the re-read; the stash source returns the revision on the 2nd read.
    const firstStash = stash()
    const revisedStash = stash({
      proposal: {
        ...createProposal,
        summary: '修订后的本周计划',
        days: [{ label: '周一', detail: '修订后的休息安排' }],
      },
      rawProposal: { folder: 'W1', plan: { week_folder: 'W1' } },
    })
    const readStash = vi
      .fn<() => StashedProposal<WeeklyProposal> | null>()
      .mockReturnValueOnce(firstStash)
      .mockReturnValue(revisedStash)
    const noop = vi.fn()
    const apply = vi.fn(async () => ({ status: 'ok' }) as CoachApplyOutcome)
    const renderChat = vi.fn(() => <div data-testid="chat">chat</div>)
    const { rerender } = render(
      <WeeklyPlanAdjustView
        userId="u1"
        folder="W1"
        readStash={readStash}
        clearStash={noop}
        apply={apply}
        abandon={vi.fn(async () => {})}
        navigate={noop}
        currentPlanSummary="本周课表 · W1"
        refreshToken="r0"
        renderChat={renderChat}
      />,
    )
    // First render shows the original diff proposal.
    expect(screen.getByText('把周三改成节奏跑')).toBeInTheDocument()
    expect(readStash).toHaveBeenCalledTimes(1)

    // Same token → no re-read even on re-render.
    rerender(
      <WeeklyPlanAdjustView
        userId="u1"
        folder="W1"
        readStash={readStash}
        clearStash={noop}
        apply={apply}
        abandon={vi.fn(async () => {})}
        navigate={noop}
        currentPlanSummary="本周课表 · W1"
        refreshToken="r0"
        renderChat={renderChat}
      />,
    )
    expect(readStash).toHaveBeenCalledTimes(1)
    expect(screen.getByText('把周三改成节奏跑')).toBeInTheDocument()

    // Token changes → stash re-read → the revised proposal replaces the Review.
    rerender(
      <WeeklyPlanAdjustView
        userId="u1"
        folder="W1"
        readStash={readStash}
        clearStash={noop}
        apply={apply}
        abandon={vi.fn(async () => {})}
        navigate={noop}
        currentPlanSummary="本周课表 · W1"
        refreshToken="r1"
        renderChat={renderChat}
      />,
    )
    expect(readStash).toHaveBeenCalledTimes(2)
    expect(screen.getByText('修订后的休息安排')).toBeInTheDocument()
    expect(screen.queryByText('把周三改成节奏跑')).not.toBeInTheDocument()
  })

  it('refreshed weekly-create stash: old calendar disappears, new content appears; nutrition/notes preserved; renderChat receives revised raw; apply submits revised raw', async () => {
    // Task #30: when a coach re-stashes a revised weekly-create draft and the
    // token changes, the new days/nutrition/notesMd appear, the old day detail
    // is gone, and apply sends the revised rawProposal to the server.
    const oldCreateStash = stash({
      proposal: {
        proposalType: 'weekly_create',
        summary: '第一版课表',
        baseRevision: 'rev-v1',
        opIds: ['op-v1'],
        days: [{ label: '2026-07-21', detail: '轻松跑 8 km' }],
        strength: [],
        nutrition: [{ label: '2026-07-21', kcalTarget: 2200, waterMl: 2000, carbsG: null, proteinG: null, fatG: null, meals: [], notesMd: null }],
        notesMd: '第一版说明',
      },
      rawProposal: { folder: 'W1', plan: { week_folder: 'W1', version: 1 } },
    })
    const revisedCreateStash = stash({
      proposal: {
        proposalType: 'weekly_create',
        summary: '修订版课表',
        baseRevision: 'rev-v2',
        opIds: ['op-v2'],
        days: [{ label: '2026-07-21', detail: '阈值跑 12 km' }],
        strength: [],
        nutrition: [{ label: '2026-07-21', kcalTarget: 2400, waterMl: 2500, carbsG: null, proteinG: null, fatG: null, meals: [], notesMd: null }],
        notesMd: '修订版说明',
      },
      rawProposal: { folder: 'W1', plan: { week_folder: 'W1', version: 2 } },
    })
    const readStash = vi
      .fn<() => StashedProposal<WeeklyProposal> | null>()
      .mockReturnValueOnce(oldCreateStash)
      .mockReturnValue(revisedCreateStash)
    const noop = vi.fn()
    const apply = vi.fn<
      (
        folder: string,
        rawProposal: Readonly<Record<string, unknown>>,
        opIds: readonly string[],
        baseRevision: string,
        impactAck?: string,
      ) => Promise<CoachApplyOutcome>
    >(async () => ({ status: 'ok' }))
    const renderChat = vi.fn(
      (anchor: string, reviewContext?: CoachReviewContext) => (
        <div
          data-testid="chat"
          data-anchor={anchor}
          data-has-review={reviewContext ? 'yes' : 'no'}
        >
          chat
        </div>
      ),
    )
    const { rerender } = render(
      <WeeklyPlanAdjustView
        userId="u1"
        folder="W1"
        readStash={readStash}
        clearStash={noop}
        apply={apply}
        abandon={vi.fn(async () => {})}
        navigate={noop}
        currentPlanSummary="本周课表 · W1"
        refreshToken="t0"
        renderChat={renderChat}
      />,
    )
    // First render: old day detail + old nutrition visible.
    expect(screen.getByText('轻松跑 8 km')).toBeInTheDocument()
    expect(screen.getByText(/2200 kcal/)).toBeInTheDocument()
    expect(screen.getByText('第一版说明')).toBeInTheDocument()

    // Token changes → revised stash loaded.
    rerender(
      <WeeklyPlanAdjustView
        userId="u1"
        folder="W1"
        readStash={readStash}
        clearStash={noop}
        apply={apply}
        abandon={vi.fn(async () => {})}
        navigate={noop}
        currentPlanSummary="本周课表 · W1"
        refreshToken="t1"
        renderChat={renderChat}
      />,
    )
    // Old content gone; new content present.
    expect(screen.queryByText('轻松跑 8 km')).not.toBeInTheDocument()
    expect(screen.getByText('阈值跑 12 km')).toBeInTheDocument()
    // Nutrition is preserved in the revision.
    expect(screen.getByText(/2400 kcal/)).toBeInTheDocument()
    // Notes preserved.
    expect(screen.getByText('修订版说明')).toBeInTheDocument()
    expect(screen.queryByText('第一版说明')).not.toBeInTheDocument()
    // renderChat was called with the revised raw proposal as review context.
    const lastReviewCtx = renderChat.mock.calls[renderChat.mock.calls.length - 1][1] as CoachReviewContext
    expect(lastReviewCtx?.kind).toBe('weekly_create')
    expect((lastReviewCtx?.proposal as Record<string, unknown>)?.plan).toMatchObject({ version: 2 })
    // Apply submits the revised raw proposal.
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(apply.mock.calls[0][1]).toEqual({ folder: 'W1', plan: { week_folder: 'W1', version: 2 } })
    expect(apply.mock.calls[0][3]).toBe('rev-v2')
  })

  it('abandons and clears the stash on discard without applying', () => {
    const { abandon, clearStash, clearPendingTurnForWeek, navigate, apply } = renderView(stash())
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(abandon).toHaveBeenCalledWith({ kind: 'weekly', folder: 'W1' })
    expect(clearPendingTurnForWeek).toHaveBeenCalledWith('W1')
    expect(clearStash).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/week/W1')
    expect(apply).not.toHaveBeenCalled()
  })
})
