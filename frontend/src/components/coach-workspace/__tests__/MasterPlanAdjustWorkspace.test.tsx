import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MasterPlanAdjustWorkspace } from '../MasterPlanAdjustWorkspace'
import type {
  ApplyOutcome,
  ApplyProposalRequest,
  MasterDiffProposal,
  StashedProposal,
} from '../types'

const masterProposal: MasterDiffProposal = {
  proposalType: 'master_diff',
  summary: '把第 8 周的峰值周挪后一周',
  baseRevision: 'mrev-1',
  changes: [
    {
      opId: 'm-op-1',
      label: '第 8 周 · 阶段',
      changeType: 'update',
      oldValue: 'peak',
      newValue: 'build',
    },
    {
      opId: 'm-op-2',
      label: '第 9 周 · 阶段',
      changeType: 'update',
      oldValue: 'build',
      newValue: 'peak',
    },
  ],
}

function makeStashed(): StashedProposal<MasterDiffProposal> {
  return {
    target: { userId: 'u1', kind: 'master', planId: 'plan-9' },
    contextAnchor: 'msg-3',
    proposal: masterProposal,
    rawProposal: {
      plan_id: 'plan-9',
      ops: masterProposal.changes.map((change) => ({ id: change.opId })),
    },
  }
}

function renderWorkspace(
  overrides: Partial<{ apply: (req: ApplyProposalRequest) => Promise<ApplyOutcome> }> = {},
) {
  const onApply = vi.fn(
    overrides.apply ?? (async () => ({ status: 'ok' }) as ApplyOutcome),
  )
  const onDiscard = vi.fn()
  render(
    <MasterPlanAdjustWorkspace
      stashed={makeStashed()}
      currentPlanSummary="16 周马拉松备战 · 当前第 7 周"
      onApply={onApply}
      onDiscard={onDiscard}
      chat={<div data-testid="chat-panel">chat</div>}
    />,
  )
  return { onApply, onDiscard }
}

describe('MasterPlanAdjustWorkspace', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the master diff changes', () => {
    renderWorkspace()
    expect(screen.getByText('第 8 周 · 阶段')).toBeInTheDocument()
    expect(screen.getAllByText('peak').length).toBeGreaterThanOrEqual(1)
  })

  it('applies the whole proposal with all op ids and base revision', async () => {
    const { onApply } = renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const req = onApply.mock.calls[0][0] as ApplyProposalRequest
    expect(req.opIds).toEqual(['m-op-1', 'm-op-2'])
    expect(req.baseRevision).toBe('mrev-1')
  })

  it('shows a stale message on 409', async () => {
    renderWorkspace({ apply: async () => ({ status: 'stale' }) })
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    expect(await screen.findByText(/方案已过期/)).toBeInTheDocument()
  })

  it('discards without applying', () => {
    const { onApply, onDiscard } = renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })
})
