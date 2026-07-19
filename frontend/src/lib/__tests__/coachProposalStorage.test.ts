import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearStashedProposal,
  readStashedProposal,
  stashProposal,
} from '../coachProposalStorage'
import type {
  ProposalTargetKey,
  StashedProposal,
  WeeklyDiffProposal,
} from '../../components/coach-workspace/types'

const weeklyTarget: ProposalTargetKey = {
  userId: 'user-1',
  kind: 'weekly',
  folder: '2026-07-13_07-19',
}

const weeklyProposal: WeeklyDiffProposal = {
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
  ],
  seasonImpact: null,
}

const stashed: StashedProposal = {
  target: weeklyTarget,
  contextAnchor: 'msg-42',
  proposal: weeklyProposal,
  rawProposal: {
    folder: '2026-07-13_07-19',
    ops: [{ id: 'op-1' }],
  },
}

describe('coachProposalStorage', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('round-trips a stashed proposal for its target', () => {
    stashProposal(stashed)
    const read = readStashedProposal(weeklyTarget)
    expect(read).toEqual(stashed)
  })

  it('returns null when nothing is stashed for the target', () => {
    expect(readStashedProposal(weeklyTarget)).toBeNull()
  })

  it('does not read a proposal stashed under a different target key', () => {
    stashProposal(stashed)
    const otherFolder: ProposalTargetKey = {
      ...weeklyTarget,
      folder: '2026-07-20_07-26',
    }
    expect(readStashedProposal(otherFolder)).toBeNull()
    // the original is untouched
    expect(readStashedProposal(weeklyTarget)).toEqual(stashed)
  })

  it('does not cross weekly and master targets', () => {
    stashProposal(stashed)
    const masterTarget: ProposalTargetKey = {
      userId: 'user-1',
      kind: 'master',
      planId: '2026-07-13_07-19',
    }
    expect(readStashedProposal(masterTarget)).toBeNull()
  })

  it('replaces an existing proposal for the same target', () => {
    stashProposal(stashed)
    const replacement: StashedProposal = {
      ...stashed,
      contextAnchor: 'msg-99',
      proposal: { ...weeklyProposal, summary: '改成长距离' },
    }
    stashProposal(replacement)
    expect(readStashedProposal(weeklyTarget)).toEqual(replacement)
  })

  it('clears a stashed proposal', () => {
    stashProposal(stashed)
    clearStashedProposal(weeklyTarget)
    expect(readStashedProposal(weeklyTarget)).toBeNull()
  })

  it('safely clears and returns null on corrupt JSON', () => {
    stashProposal(stashed)
    // Corrupt the underlying value directly.
    const key = Object.keys(sessionStorage).find((k) => k.includes('coach:proposal'))
    expect(key).toBeDefined()
    if (key) sessionStorage.setItem(key, '{not valid json')
    expect(readStashedProposal(weeklyTarget)).toBeNull()
    // corrupt entry was purged
    if (key) expect(sessionStorage.getItem(key)).toBeNull()
  })

  it('returns null and purges when the stored target key mismatches', () => {
    stashProposal(stashed)
    const key = Object.keys(sessionStorage).find((k) => k.includes('coach:proposal'))
    if (key) {
      const raw = sessionStorage.getItem(key)
      const parsed = JSON.parse(raw as string)
      // Tamper the embedded target so it no longer matches its key.
      parsed.target.userId = 'someone-else'
      sessionStorage.setItem(key, JSON.stringify(parsed))
    }
    expect(readStashedProposal(weeklyTarget)).toBeNull()
    if (key) expect(sessionStorage.getItem(key)).toBeNull()
  })

  it('does not mutate the input object when stashing', () => {
    const frozen = Object.freeze({ ...stashed })
    expect(() => stashProposal(frozen)).not.toThrow()
  })
})
