import { describe, expect, it } from 'vitest'

import { fingerprintProposal } from '../draftRevision'

describe('fingerprintProposal', () => {
  it('is stable across object key order', () => {
    const first = { folder: 'w', plan: { sessions: [], nutrition: [] } }
    const second = { plan: { nutrition: [], sessions: [] }, folder: 'w' }

    expect(fingerprintProposal(first)).toBe(fingerprintProposal(second))
  })

  it('changes when draft content changes', () => {
    const first = { folder: 'w', plan: { sessions: [{ date: '2026-07-20' }] } }
    const second = { folder: 'w', plan: { sessions: [{ date: '2026-07-21' }] } }

    expect(fingerprintProposal(first)).not.toBe(fingerprintProposal(second))
  })

  it('returns the same token when an identical revision is selected again', () => {
    const proposal = {
      folder: '2026-07-20_07-26',
      plan: { sessions: [{ date: '2026-07-20', summary: '轻松跑 8 km' }] },
    }

    expect(fingerprintProposal(proposal)).toBe(fingerprintProposal({ ...proposal }))
  })
})
