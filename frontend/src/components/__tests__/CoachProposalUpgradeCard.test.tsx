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
import { fingerprintProposal } from '../coach-workspace/draftRevision'

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
        base_revision: 'rev-1',
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
        ai_explanation: '用轻松跑承接恢复，再逐步恢复阈值刺激。',
        plan: {
          week_folder: '2026-07-20_07-26',
          notes_md: '本周以恢复为主。',
          sessions: [
            { date: '2026-07-20', session_index: 0, kind: 'run', summary: '轻松跑 8 km' },
            {
              date: '2026-07-21',
              session_index: 0,
              kind: 'strength',
              summary: '下肢力量',
              spec: {
                name: '下肢力量 A',
                exercises: [
                  {
                    canonical_id: 'T1262',
                    display_name: '高脚杯深蹲',
                    sets: 3,
                    target_kind: 'reps',
                    target_value: 12,
                    rest_seconds: 90,
                  },
                ],
              },
            },
            { date: '2026-07-22', session_index: 0, kind: 'run', summary: '阈值跑 10 km' },
          ],
          nutrition: [
            { date: '2026-07-20', kcal_target: 2400, water_ml: 2500, meals: [] },
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
      // Every session stays on the calendar, strength included.
      expect(stored.proposal.days).toEqual([
        { label: '2026-07-20', detail: '轻松跑 8 km' },
        { label: '2026-07-21', detail: '下肢力量' },
        { label: '2026-07-22', detail: '阈值跑 10 km' },
      ])
      expect(stored.proposal.strength).toHaveLength(1)
      expect(stored.proposal.strength[0].exercises[0]).toMatchObject({
        name: '高脚杯深蹲',
        sets: 3,
        target: '12 次',
        rest: '休息 90 秒',
      })
      expect(stored.proposal.nutrition).toHaveLength(1)
      expect(stored.proposal.nutrition[0]).toMatchObject({ kcalTarget: 2400, waterMl: 2500 })
      expect(stored.proposal.notesMd).toBe('本周以恢复为主。')
    }
    // rawProposal is preserved verbatim for apply.
    expect(stored?.rawProposal).toEqual(proposal.proposal)
  })

  it('maps advisory season impact without turning it into a blocking material warning', () => {
    const proposal = {
      specialist_id: 'weekly_plan',
      summary: '本周小幅减量',
      target: { kind: 'week' as const, folder: '2026-07-13_07-19' },
      proposal: {
        folder: '2026-07-13_07-19',
        ops: [{ id: 'op1', op: 'replace_distance' }],
        base_revision: 'rev-advisory',
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
        base_revision: 'rev-material',
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
      proposal: { plan_id: 'plan-9', ops: [], base_revision: '3' },
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

  it('carries a stable draftRevision fingerprint in navigation state for a weekly create proposal', () => {
    const rawProposalBody = {
      proposal_id: 'create-2',
      folder: '2026-07-20_07-26',
      plan: {
        week_folder: '2026-07-20_07-26',
        sessions: [{ date: '2026-07-20', kind: 'run', summary: '轻松跑 8 km' }],
      },
    }
    const proposal = {
      specialist_id: 'weekly_plan',
      summary: '创建本周计划',
      target: { kind: 'week' as const, folder: '2026-07-20_07-26' },
      proposal: rawProposalBody,
      base_revision: null,
      season_impact: null,
    }
    renderCard({ userId: 'user-1', proposal })

    fireEvent.click(screen.getByRole('button'))

    const expectedFingerprint = fingerprintProposal(rawProposalBody)
    expect(navigateMock).toHaveBeenCalledWith('/coach/week/2026-07-20_07-26/adjust', {
      state: { draftRevision: expectedFingerprint },
    })
    // Calling again with the same proposal body produces the same fingerprint (idempotent).
    navigateMock.mockReset()
    sessionStorage.clear()
    fireEvent.click(screen.getByRole('button'))
    expect(navigateMock).toHaveBeenCalledWith('/coach/week/2026-07-20_07-26/adjust', {
      state: { draftRevision: expectedFingerprint },
    })
  })

  it('does NOT carry navigation state for a weekly diff proposal', () => {
    const proposal = {
      specialist_id: 'week',
      summary: '本周降量',
      target: { kind: 'week' as const, folder: '2026-07-13_07-19' },
      proposal: {
        folder: '2026-07-13_07-19',
        ops: [{ id: 'op1', op: 'replace_note', label: '周三配速', new_value: '5:30' }],
        base_revision: 'rev-1',
      },
      base_revision: 'rev-1',
      season_impact: null,
    }
    renderCard({ userId: 'user-1', proposal })

    fireEvent.click(screen.getByRole('button'))

    expect(navigateMock).toHaveBeenCalledWith('/coach/week/2026-07-13_07-19/adjust')
  })

  it('does NOT carry navigation state for a master diff proposal', () => {
    const proposal = {
      specialist_id: 'master',
      summary: '赛季重排',
      target: { kind: 'master' as const, plan_id: 'plan-9' },
      proposal: { plan_id: 'plan-9', ops: [], base_revision: '3' },
      base_revision: '3',
      season_impact: null,
    }
    renderCard({ userId: 'user-1', proposal })

    fireEvent.click(screen.getByRole('button'))

    expect(navigateMock).toHaveBeenCalledWith('/coach/master/plan-9/adjust')
  })

  it('renders no actionable card when a diff revision is missing or mismatched', () => {
    const base = {
      specialist_id: 'weekly_plan',
      summary: '本周降量',
      target: { kind: 'week' as const, folder: '2026-07-13_07-19' },
      season_impact: null,
    }
    const missing = renderCard({
      userId: 'user-1',
      proposal: {
        ...base,
        proposal: { folder: '2026-07-13_07-19', ops: [] },
        base_revision: 'rev-1',
      },
    })
    expect(missing.container.querySelector('button')).toBeNull()
    missing.unmount()

    const mismatched = renderCard({
      userId: 'user-1',
      proposal: {
        ...base,
        proposal: {
          folder: '2026-07-13_07-19',
          ops: [],
          base_revision: 'rev-old',
        },
        base_revision: 'rev-new',
      },
    })
    expect(mismatched.container.querySelector('button')).toBeNull()
  })

  it('renders no actionable card for an empty weekly-create proposal', () => {
    const proposal = {
      specialist_id: 'weekly_plan',
      summary: '清空后重新生成',
      target: { kind: 'week' as const, folder: '2026-07-20_07-26' },
      proposal: {
        proposal_id: 'empty-1',
        folder: '2026-07-20_07-26',
        plan: { week_folder: '2026-07-20_07-26', sessions: [] },
      },
      base_revision: null,
      season_impact: null,
    }

    const { container } = renderCard({ userId: 'user-1', proposal })

    expect(container.querySelector('button')).toBeNull()
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('renders nothing when neither proposal nor target resolves a plan', () => {
    const { container } = renderCard({ userId: 'user-1' })
    expect(container.firstChild).toBeNull()
  })
})
