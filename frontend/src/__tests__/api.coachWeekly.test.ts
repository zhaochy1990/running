import { describe, expect, it, vi } from 'vitest'

import {
  applyCoachWeekReplacement,
  sendCoachChat,
  weeklyProposalFromChat,
  type CoachChatResponse,
  type WeeklyPlanCreateProposal,
} from '../api'

const FOLDER = '2026-05-11_05-17'

function makeProposal(): WeeklyPlanCreateProposal {
  return {
    proposal_id: 'p1',
    folder: FOLDER,
    plan: {
      schema: 'weekly-plan/v1',
      week_folder: FOLDER,
      sessions: [],
      nutrition: [],
      notes_md: null,
    },
    total_distance_km: 42,
    ai_explanation: 'regenerated',
    created_at: '2026-05-10T00:00:00Z',
  }
}

describe('weekly coach chat api', () => {
  it('posts session_id + message to the coach chat endpoint', async () => {
    const chat: CoachChatResponse = {
      session_id: 's1',
      thread_id: 't1',
      reply: '好的',
      clarification: null,
      proposals: [
        { specialist_id: 'weekly_plan', proposal: makeProposal() },
      ],
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(chat)))

    const response = await sendCoachChat('s1', '重新生成本周训练计划')

    expect(response.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/users/me/coach/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 's1', message: '重新生成本周训练计划' }),
    })

    const proposal = weeklyProposalFromChat(response.data)
    expect(proposal?.folder).toBe(FOLDER)
  })

  it('returns null when no weekly_plan proposal is present', () => {
    const chat: CoachChatResponse = {
      session_id: 's1',
      thread_id: 't1',
      reply: '这是一个问题的回答',
      proposals: [{ specialist_id: 'status_insight', proposal: {} }],
    }
    expect(weeklyProposalFromChat(chat)).toBeNull()
  })

  it('posts the proposal with replace=true to the weekly apply endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          applied: 1,
          folder: FOLDER,
          created: false,
          replaced: true,
          updated_at: '2026-05-10T00:00:00Z',
        }),
      ),
    )
    const proposal = makeProposal()

    const response = await applyCoachWeekReplacement(FOLDER, proposal)

    expect(response.data.replaced).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/users/me/coach/plan/${FOLDER}/apply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal, replace: true }),
      },
    )
  })
})
