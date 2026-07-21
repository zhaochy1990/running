import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MasterPlanAdjustView } from '../MasterPlanAdjustPage'
import type { CoachApplyOutcome } from '../../api'
import type {
  MasterDiffProposal,
  StashedProposal,
} from '../../components/coach-workspace/types'

const proposal: MasterDiffProposal = {
  proposalType: 'master_diff',
  summary: '峰值周挪后一周',
  baseRevision: '4',
  changes: [{ opId: 'm-1', label: '第 8 周', changeType: 'update', oldValue: 'peak', newValue: 'build' }],
}

function stash(): StashedProposal<MasterDiffProposal> {
  return {
    target: { userId: 'u1', kind: 'master', planId: 'plan-9' },
    contextAnchor: 'msg-3',
    proposal,
    rawProposal: { plan_id: 'plan-9', ops: [{ id: 'm-1' }] },
  }
}

function renderView(
  stashed: StashedProposal<MasterDiffProposal> | null,
  applyImpl?: () => Promise<CoachApplyOutcome>,
) {
  const readStash = vi.fn(() => stashed)
  const clearStash = vi.fn()
  const apply = vi.fn<
    (
      planId: string,
      rawProposal: Readonly<Record<string, unknown>>,
      opIds: readonly string[],
      baseRevision: string,
    ) => Promise<CoachApplyOutcome>
  >(applyImpl ?? (async () => ({ status: 'ok' }) as CoachApplyOutcome))
  const abandon = vi.fn(async () => {})
  const navigate = vi.fn()
  render(
    <MasterPlanAdjustView
      userId="u1"
      planId="plan-9"
      readStash={readStash}
      clearStash={clearStash}
      apply={apply}
      abandon={abandon}
      navigate={navigate}
      currentPlanSummary="赛季训练计划"
      renderChat={(anchor) => <div data-testid="chat" data-anchor={anchor}>chat</div>}
    />,
  )
  return { readStash, clearStash, apply, abandon, navigate }
}

describe('MasterPlanAdjustView', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders intake with no apply CTA when there is no stash', () => {
    renderView(null)
    expect(screen.getByText(/告诉 Coach/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '启用计划' })).not.toBeInTheDocument()
  })

  it('applies the stashed proposal and navigates to /plan with success state', async () => {
    const { apply, clearStash, navigate } = renderView(stash())
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    expect(apply.mock.calls[0][0]).toBe('plan-9')
    expect(apply.mock.calls[0][1]).toEqual({ plan_id: 'plan-9', ops: [{ id: 'm-1' }] })
    expect(apply.mock.calls[0][2]).toEqual(['m-1'])
    expect(apply.mock.calls[0][3]).toBe('4')
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/plan', { coachPlanApplied: true }))
    expect(clearStash).toHaveBeenCalled()
  })

  it('abandons and clears the stash on discard, returning to /plan', () => {
    const { abandon, clearStash, navigate, apply } = renderView(stash())
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(abandon).toHaveBeenCalledWith({ kind: 'master', planId: 'plan-9' })
    expect(clearStash).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/plan')
    expect(apply).not.toHaveBeenCalled()
  })
})
