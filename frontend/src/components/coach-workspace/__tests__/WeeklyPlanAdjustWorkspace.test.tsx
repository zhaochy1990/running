import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WeeklyPlanAdjustWorkspace } from '../WeeklyPlanAdjustWorkspace'
import type {
  ApplyOutcome,
  ApplyProposalRequest,
  StashedProposal,
  WeeklyCreateProposal,
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

  it('renders training, strength, and nutrition surfaces for a create proposal', () => {
    const createProposal: WeeklyCreateProposal = {
      proposalType: 'weekly_create',
      summary: '创建下一周课表',
      baseRevision: 'rev-create',
      opIds: ['op-a', 'op-b'],
      days: [{ label: '2026-07-20', detail: '轻松跑 8 km' }],
      strength: [
        {
          label: '2026-07-21',
          title: '下肢力量 A',
          note: null,
          exercises: [{ name: '高脚杯深蹲', sets: 3, target: '12 次', rest: '休息 90 秒', note: null }],
        },
      ],
      nutrition: [
        {
          label: '2026-07-20',
          kcalTarget: 2400,
          carbsG: null,
          proteinG: null,
          fatG: null,
          waterMl: 2500,
          notesMd: null,
          meals: [],
        },
      ],
      notesMd: '本周以恢复为主。',
    }
    const stashed: StashedProposal<WeeklyCreateProposal> = {
      target: { userId: 'u1', kind: 'weekly', folder: '2026-07-20_07-26' },
      contextAnchor: 'msg-2',
      proposal: createProposal,
      rawProposal: { folder: '2026-07-20_07-26', plan: {} },
    }
    render(
      <WeeklyPlanAdjustWorkspace
        stashed={stashed}
        currentPlanSummary="尚无本周计划"
        onApply={vi.fn(async () => ({ status: 'ok' }) as ApplyOutcome)}
        onDiscard={vi.fn()}
        chat={<div data-testid="chat-panel">chat</div>}
      />,
    )
    expect(screen.getByText('本周训练日历')).toBeInTheDocument()
    expect(screen.getByText('力量训练')).toBeInTheDocument()
    expect(screen.getByText('高脚杯深蹲')).toBeInTheDocument()
    expect(screen.getByText('营养安排')).toBeInTheDocument()
    expect(screen.getByText('本周说明')).toBeInTheDocument()
    expect(screen.getByText('本周以恢复为主。')).toBeInTheDocument()
  })

  it('applies a create proposal with its op ids and keeps rawProposal untouched', async () => {
    const rawProposal = { folder: '2026-07-20_07-26', plan: { sessions: [] } }
    const createProposal: WeeklyCreateProposal = {
      proposalType: 'weekly_create',
      summary: '创建下一周课表',
      baseRevision: 'rev-create',
      opIds: ['op-a', 'op-b'],
      days: [{ label: '2026-07-20', detail: '轻松跑' }],
      strength: [],
      nutrition: [],
      notesMd: null,
    }
    const stashed: StashedProposal<WeeklyCreateProposal> = {
      target: { userId: 'u1', kind: 'weekly', folder: '2026-07-20_07-26' },
      contextAnchor: 'msg-2',
      proposal: createProposal,
      rawProposal,
    }
    const onApply = vi.fn<(req: ApplyProposalRequest) => Promise<ApplyOutcome>>(
      async () => ({ status: 'ok' }) as ApplyOutcome,
    )
    render(
      <WeeklyPlanAdjustWorkspace
        stashed={stashed}
        currentPlanSummary="尚无本周计划"
        onApply={onApply}
        onDiscard={vi.fn()}
        chat={<div>chat</div>}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '启用计划' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const req = onApply.mock.calls[0][0] as ApplyProposalRequest
    expect(req.opIds).toEqual(['op-a', 'op-b'])
    // rawProposal is preserved verbatim for apply.
    expect(stashed.rawProposal).toEqual({ folder: '2026-07-20_07-26', plan: { sessions: [] } })
  })
})
