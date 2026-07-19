/**
 * Tests for CoachProposalUpgradeCard — the chat→adjust-workspace escalation.
 *
 * Verifies the navigation contract (weekly vs master path) and that the raw
 * backend proposal is normalized and stashed via the shared coachProposalStorage
 * (keyed by user + target), so the workspace reads it back with readStashedProposal.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readStashedProposal } from '../../lib/coachProposalStorage'

const navigateMock = vi.hoisted(() => vi.fn())
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})

import CoachProposalUpgradeCard from '../CoachProposalUpgradeCard'

function renderCard(props: React.ComponentProps<typeof CoachProposalUpgradeCard>) {
  return render(
    <MemoryRouter>
      <CoachProposalUpgradeCard {...props} />
    </MemoryRouter>,
  )
}

describe('CoachProposalUpgradeCard', () => {
  beforeEach(() => {
    navigateMock.mockReset()
    sessionStorage.clear()
  })

  it('normalizes a weekly diff proposal, stashes it, and navigates to the weekly path', () => {
    const proposal = {
      specialist_id: 'week',
      summary: '本周降量',
      target: { kind: 'week' as const, folder: '2026-07-13_07-19' },
      proposal: {
        folder: '2026-07-13_07-19',
        ops: [{ id: 'op1', op: 'replace_note', label: '周三配速', new_value: '5:30' }],
      },
      base_revision: 'rev-1',
      season_impact: null,
    }
    renderCard({ userId: 'user-1', proposal, contextAnchor: 'msg-42' })

    fireEvent.click(screen.getByRole('button'))

    expect(navigateMock).toHaveBeenCalledWith('/coach/week/2026-07-13_07-19/adjust')
    const stored = readStashedProposal({ userId: 'user-1', kind: 'weekly', folder: '2026-07-13_07-19' })
    expect(stored).not.toBeNull()
    expect(stored?.contextAnchor).toBe('msg-42')
    expect(stored?.proposal.proposalType).toBe('weekly_diff')
    expect(stored?.proposal.summary).toBe('本周降量')
    expect(stored?.proposal.baseRevision).toBe('rev-1')
    expect(stored?.rawProposal).toEqual(proposal.proposal)
  })

  it('projects a weekly create proposal into reviewable day rows', () => {
    const proposal = {
      specialist_id: 'weekly_plan',
      summary: '创建下一周课表',
      target: { kind: 'week' as const, folder: '2026-07-20_07-26' },
      proposal: {
        proposal_id: 'create-1',
        folder: '2026-07-20_07-26',
        plan: {
          week_folder: '2026-07-20_07-26',
          sessions: [
            { date: '2026-07-20', session_index: 0, summary: '轻松跑 8 km' },
            { date: '2026-07-22', session_index: 0, summary: '阈值跑 10 km' },
          ],
        },
      },
      base_revision: null,
      season_impact: { level: 'none' as const, reasons: [], metrics: {} },
    }
    renderCard({ userId: 'user-1', proposal })

    fireEvent.click(screen.getByRole('button'))

    const stored = readStashedProposal({ userId: 'user-1', kind: 'weekly', folder: '2026-07-20_07-26' })
    expect(stored?.proposal.proposalType).toBe('weekly_create')
    if (stored?.proposal.proposalType === 'weekly_create') {
      expect(stored.proposal.days).toEqual([
        { label: '2026-07-20', detail: '轻松跑 8 km' },
        { label: '2026-07-22', detail: '阈值跑 10 km' },
      ])
    }
  })

  it('maps advisory season impact without turning it into a blocking material warning', () => {
    const proposal = {
      specialist_id: 'weekly_plan',
      summary: '本周小幅减量',
      target: { kind: 'week' as const, folder: '2026-07-13_07-19' },
      proposal: {
        folder: '2026-07-13_07-19',
        ops: [{ id: 'op1', op: 'replace_distance' }],
      },
      base_revision: 'rev-advisory',
      season_impact: {
        level: 'advisory' as const,
        reasons: ['本周跑量略低于阶段目标下限'],
        metrics: {},
      },
    }
    renderCard({ userId: 'user-1', proposal })

    fireEvent.click(screen.getByRole('button'))

    const stored = readStashedProposal({ userId: 'user-1', kind: 'weekly', folder: '2026-07-13_07-19' })
    expect(stored?.proposal.proposalType).toBe('weekly_diff')
    if (stored?.proposal.proposalType === 'weekly_diff') {
      expect(stored.proposal.baseRevision).toBe('rev-advisory')
      expect(stored.proposal.seasonImpact).toBeNull()
      expect(stored.proposal.seasonImpactProjection).toEqual({
        level: 'advisory',
        reasons: ['本周跑量略低于阶段目标下限'],
      })
    }
  })

  it('maps material season impact into a blocking warning', () => {
    const proposal = {
      specialist_id: 'weekly_plan',
      summary: '删除关键长跑',
      target: { kind: 'week' as const, folder: '2026-07-13_07-19' },
      proposal: {
        folder: '2026-07-13_07-19',
        ops: [{ id: 'op1', op: 'remove_session' }],
      },
      base_revision: 'rev-material',
      season_impact: {
        level: 'material' as const,
        reasons: ['调整会移除阶段关键长跑'],
        metrics: {},
      },
    }
    renderCard({ userId: 'user-1', proposal })

    fireEvent.click(screen.getByRole('button'))

    const stored = readStashedProposal({ userId: 'user-1', kind: 'weekly', folder: '2026-07-13_07-19' })
    if (stored?.proposal.proposalType === 'weekly_diff') {
      expect(stored.proposal.seasonImpact).toBe('调整会移除阶段关键长跑')
      expect(stored.proposal.seasonImpactProjection?.level).toBe('material')
    } else {
      throw new Error('expected weekly diff proposal')
    }
  })

  it('normalizes a master diff proposal and navigates to the master path', () => {
    const proposal = {
      specialist_id: 'master',
      summary: '赛季重排',
      target: { kind: 'master' as const, plan_id: 'plan-9' },
      proposal: { plan_id: 'plan-9', ops: [] },
      base_revision: '3',
      season_impact: null,
    }
    renderCard({ userId: 'user-1', proposal })

    fireEvent.click(screen.getByRole('button'))

    expect(navigateMock).toHaveBeenCalledWith('/coach/master/plan-9/adjust')
    const stored = readStashedProposal({ userId: 'user-1', kind: 'master', planId: 'plan-9' })
    expect(stored?.proposal.proposalType).toBe('master_diff')
  })

  it('renders an upgrade entry from an active target without a proposal', () => {
    renderCard({ userId: 'user-1', activeTarget: { kind: 'week', folder: '2026-07-13_07-19' } })

    fireEvent.click(screen.getByRole('button'))
    expect(navigateMock).toHaveBeenCalledWith('/coach/week/2026-07-13_07-19/adjust')
    // No proposal body — nothing stashed, the workspace refetches the plan.
    expect(
      readStashedProposal({ userId: 'user-1', kind: 'weekly', folder: '2026-07-13_07-19' }),
    ).toBeNull()
  })

  it('renders nothing when neither proposal nor target resolves a plan', () => {
    const { container } = renderCard({ userId: 'user-1' })
    expect(container.firstChild).toBeNull()
  })
})
