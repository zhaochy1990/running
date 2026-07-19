import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WeeklyPlanAdjustView } from '../WeeklyPlanAdjustPage'
import type { CoachApplyOutcome } from '../../api'
import type {
  StashedProposal,
  WeeklyDiffProposal,
  WeeklyProposal,
} from '../../components/coach-workspace/types'

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
  apply: ReturnType<typeof vi.fn>
  abandon: ReturnType<typeof vi.fn>
  navigate: ReturnType<typeof vi.fn>
}

function renderView(
  stashed: StashedProposal<WeeklyProposal> | null,
  applyImpl?: () => Promise<CoachApplyOutcome>,
): Deps {
  const readStash = vi.fn(() => stashed)
  const clearStash = vi.fn()
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
  render(
    <WeeklyPlanAdjustView
      userId="u1"
      folder="W1"
      readStash={readStash}
      clearStash={clearStash}
      apply={apply}
      abandon={abandon}
      navigate={navigate}
      currentPlanSummary="本周课表 · W1"
      renderChat={(anchor) => <div data-testid="chat" data-anchor={anchor}>chat</div>}
    />,
  )
  return { readStash, clearStash, apply, abandon, navigate }
}

describe('WeeklyPlanAdjustView', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the intake state with no apply CTA when there is no stash', () => {
    renderView(null)
    expect(screen.getByText(/告诉 Coach/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '启用计划' })).not.toBeInTheDocument()
  })

  it('reviews and applies the stashed proposal, then navigates back with success state', async () => {
    const { apply, clearStash, navigate } = renderView(stash())
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    // apply gets folder, raw proposal, op ids, base revision
    expect(apply.mock.calls[0][0]).toBe('W1')
    expect(apply.mock.calls[0][1]).toEqual({ folder: 'W1', ops: [{ id: 'op-1' }] })
    expect(apply.mock.calls[0][2]).toEqual(['op-1'])
    expect(apply.mock.calls[0][3]).toBe('rev-abc')
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/week/W1', { coachPlanApplied: true }))
    expect(clearStash).toHaveBeenCalled()
  })

  it('passes the context anchor to the chat', () => {
    renderView(stash())
    expect(screen.getByTestId('chat')).toHaveAttribute('data-anchor', 'msg-7')
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

  it('abandons and clears the stash on discard without applying', () => {
    const { abandon, clearStash, navigate, apply } = renderView(stash())
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(abandon).toHaveBeenCalledWith({ kind: 'weekly', folder: 'W1' })
    expect(clearStash).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/week/W1')
    expect(apply).not.toHaveBeenCalled()
  })
})
