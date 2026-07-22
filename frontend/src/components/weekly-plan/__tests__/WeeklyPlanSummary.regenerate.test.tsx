import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanDay, WeekDetail } from '../../../api'

const api = vi.hoisted(() => ({
  sendCoachChat: vi.fn(),
  applyCoachWeekReplacement: vi.fn(),
}))

vi.mock('../../../api', async () => {
  const actual = await vi.importActual<typeof import('../../../api')>('../../../api')
  return { ...actual, ...api }
})

import WeeklyPlanSummary from '../WeeklyPlanSummary'

const FOLDER = '2026-05-11_05-17'

const week = {
  folder: FOLDER,
  date_from: '2026-05-11',
  date_to: '2026-05-17',
  activities: [],
  activity_count: 0,
  total_duration_fmt: '0:00',
} as unknown as WeekDetail

const days: PlanDay[] = [
  { date: '2026-05-11', sessions: [], nutrition: null },
  { date: '2026-05-12', sessions: [], nutrition: null },
]

describe('WeeklyPlanSummary regenerate entry', () => {
  beforeEach(() => {
    api.sendCoachChat.mockReset()
    api.applyCoachWeekReplacement.mockReset()
  })

  it('opens the regenerate modal and drives generate → preview → confirm', async () => {
    api.sendCoachChat.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        session_id: 's',
        thread_id: 't',
        reply: '好的',
        proposals: [
          {
            specialist_id: 'weekly_plan',
            proposal: {
              proposal_id: 'p1',
              folder: FOLDER,
              plan: { schema: 'weekly-plan/v1', week_folder: FOLDER, sessions: [], nutrition: [], notes_md: null },
              total_distance_km: 40,
              ai_explanation: '已重新生成',
              created_at: '2026-05-10T00:00:00Z',
            },
          },
        ],
      },
    })
    api.applyCoachWeekReplacement.mockResolvedValue({
      ok: true,
      status: 200,
      data: { applied: 1, folder: FOLDER, created: false, replaced: true, updated_at: 'x' },
    })
    const onRegenerated = vi.fn()

    render(
      <WeeklyPlanSummary week={week} days={days} folder={FOLDER} onRegenerated={onRegenerated} />,
    )

    fireEvent.click(screen.getByTestId('regenerate-week-button'))
    expect(screen.getByTestId('regenerate-week-modal')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('regenerate-week-generate'))
    await waitFor(() =>
      expect(screen.getByTestId('regenerate-week-confirm')).toBeInTheDocument(),
    )
    expect(api.sendCoachChat).toHaveBeenCalledWith(
      expect.stringContaining('regen-'),
      '重新生成本周训练计划',
    )
    // both current + proposed columns render for the confirm preview
    expect(screen.getByTestId('regenerate-week-current')).toBeInTheDocument()
    expect(screen.getByTestId('regenerate-week-proposed')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('regenerate-week-confirm'))
    await waitFor(() =>
      expect(api.applyCoachWeekReplacement).toHaveBeenCalledWith(
        FOLDER,
        expect.objectContaining({ proposal_id: 'p1', folder: FOLDER }),
      ),
    )
    await waitFor(() => expect(onRegenerated).toHaveBeenCalled())
  })

  it('renders a disabled button when there is no folder', () => {
    render(<WeeklyPlanSummary week={week} days={days} folder={null} />)
    expect(screen.getByTestId('regenerate-week-button')).toBeDisabled()
  })
})
