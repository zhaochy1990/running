import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WeeklyPlanAdjustWorkspace } from '../WeeklyPlanAdjustWorkspace'
import type {
  ApplyOutcome,
  ApplyProposalRequest,
  StashedProposal,
  WeeklyDiffProposal,
} from '../types'

const baseDiffProposal: WeeklyDiffProposal = {
  proposalType: 'weekly_diff',
  summary: '把周三改成节奏跑',
  baseRevision: 'rev-abc',
  changes: [
    {
      opId: 'op-1',
      label: '周三 · 配速目标',
      changeType: 'update',
      oldValue: '5:30',
      newValue: '5:00',
    },
    {
      opId: 'op-2',
      label: '周三 · 距离',
      changeType: 'update',
      oldValue: '8km',
      newValue: '10km',
    },
  ],
  seasonImpact: null,
}

function makeStashed(proposal: WeeklyDiffProposal): StashedProposal<WeeklyDiffProposal> {
  return {
    target: { userId: 'u1', kind: 'weekly', folder: '2026-07-13_07-19' },
    contextAnchor: 'msg-1',
    proposal,
    rawProposal: {
      folder: '2026-07-13_07-19',
      ops: proposal.changes.map((change) => ({ id: change.opId })),
    },
  }
}

interface Harness {
  onApply: ReturnType<typeof vi.fn>
  onDiscard: ReturnType<typeof vi.fn>
}

function renderWorkspace(
  proposal: WeeklyDiffProposal,
  overrides: Partial<{ apply: (req: ApplyProposalRequest) => Promise<ApplyOutcome> }> = {},
): Harness {
  const onApply = vi.fn(
    overrides.apply ?? (async () => ({ status: 'ok' }) as ApplyOutcome),
  )
  const onDiscard = vi.fn()
  render(
    <WeeklyPlanAdjustWorkspace
      stashed={makeStashed(proposal)}
      currentPlanSummary="当前第 3 周 · 基础期"
      onApply={onApply}
      onDiscard={onDiscard}
      chat={<div data-testid="chat-panel">chat</div>}
    />,
  )
  return { onApply, onDiscard }
}

describe('WeeklyPlanAdjustWorkspace', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders old and new values for each diff change', () => {
    renderWorkspace(baseDiffProposal)
    expect(screen.getByText('5:30')).toBeInTheDocument()
    expect(screen.getByText('5:00')).toBeInTheDocument()
    expect(screen.getByText('周三 · 配速目标')).toBeInTheDocument()
    expect(screen.getAllByText('变更为')).toHaveLength(2)
  })

  it('applies the whole proposal with all op ids and base revision', async () => {
    const { onApply } = renderWorkspace(baseDiffProposal)
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const req = onApply.mock.calls[0][0] as ApplyProposalRequest
    expect(req.opIds).toEqual(['op-1', 'op-2'])
    expect(req.baseRevision).toBe('rev-abc')
    expect(req.impactAcknowledgement).toBeUndefined()
  })

  it('blocks apply on material season impact until acknowledged', async () => {
    const material = { ...baseDiffProposal, seasonImpact: '会挤压下周的长距离' }
    const { onApply } = renderWorkspace(material)
    // impact must be surfaced
    expect(screen.getByText('会挤压下周的长距离')).toBeInTheDocument()
    const applyBtn = screen.getByRole('button', { name: '启用计划' })
    expect(applyBtn).toBeDisabled()
    // acknowledge "仍只调整本周"
    fireEvent.click(screen.getByRole('checkbox', { name: /仍只调整本周/ }))
    expect(applyBtn).not.toBeDisabled()
    fireEvent.click(applyBtn)
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const req = onApply.mock.calls[0][0] as ApplyProposalRequest
    expect(req.impactAcknowledgement).toBe('weekly_only')
  })

  it('shows a stale message on 409 and offers regeneration', async () => {
    const { onApply, onDiscard } = renderWorkspace(baseDiffProposal, {
      apply: async () => ({ status: 'stale' }),
    })
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(onApply).toHaveBeenCalled())
    expect(await screen.findByText(/方案已过期/)).toBeInTheDocument()
    // regenerate path clears + discards
    fireEvent.click(screen.getByRole('button', { name: /重新生成/ }))
    expect(onDiscard).toHaveBeenCalled()
  })

  it('discards without applying', () => {
    const { onApply, onDiscard } = renderWorkspace(baseDiffProposal)
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
  })

  it('renders the injected chat panel', () => {
    renderWorkspace(baseDiffProposal)
    // the injected chat node is mounted exactly once
    expect(screen.getAllByTestId('chat-panel')).toHaveLength(1)
  })
})
