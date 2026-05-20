import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { getActivity, getPlanDays } from '../../api'
import { UserContext } from '../../UserContextValue'
import ActivityDetailPage from '../ActivityDetailPage'

vi.mock('../../api', () => ({
  getActivity: vi.fn(),
  getTeamActivity: vi.fn(),
  resyncActivity: vi.fn(),
  regenerateCommentary: vi.fn(),
  getPlanDays: vi.fn(),
  formatDate: (value: string) => value,
  formatTime: (value: string) => value,
  sportColor: () => '#00a85a',
  trainTypeColor: () => '#0097a7',
  sportNameCN: (value: string) => value,
  trainTypeCN: (value: string | null) => value ?? '',
}))

const activity = {
  label_id: 'run1',
  name: 'Easy Run',
  sport_type: 402,
  sport_name: 'Strength',
  date: '2026-05-19T06:30:00+08:00',
  distance_m: 0,
  distance_km: 0,
  duration_s: 3600,
  duration_fmt: '01:00:00',
  avg_pace_s_km: null,
  pace_fmt: '—',
  avg_hr: 145,
  max_hr: 170,
  avg_cadence: null,
  calories_kcal: 420,
  training_load: 321,
  vo2max: null,
  train_type: null,
  ascent_m: null,
  aerobic_effect: 3.2,
  anaerobic_effect: 1.1,
  temperature: null,
  humidity: null,
  feels_like: null,
  wind_speed: null,
  feel_type: null,
  sport_note: null,
  pauses: [],
  route_thumb: null,
}

function renderActivityDetail() {
  return render(
    <UserContext.Provider value={{ user: 'test-user', displayName: 'Test User', refresh: async () => {} }}>
      <MemoryRouter initialEntries={['/activity/run1']}>
        <Routes>
          <Route path="/activity/:id" element={<ActivityDetailPage />} />
        </Routes>
      </MemoryRouter>
    </UserContext.Provider>,
  )
}

describe('ActivityDetailPage', () => {
  it('labels provider load as watch load and renders STRIDE load when present', async () => {
    vi.mocked(getActivity).mockResolvedValue({
      activity,
      laps: [],
      segments: [],
      zones: [],
      timeseries: [],
      linked_scheduled_workout: null,
      stride_training_load: {
        label_id: 'run1',
        activity_date: '2026-05-19',
        sport: 'run_outdoor',
        session_class: 'easy',
        algorithm_version: 1,
        calibration_id: null,
        cardio_load_raw: 70.5,
        cardio_tss: 84.2,
        external_tss: 91.4,
        mechanical_load: 10.3,
        subjective_internal_load: null,
        training_dose: 86.4,
        load_confidence: 'high',
        excluded_from_pmc: false,
        reasons: ['gps_ok'],
      },
    } as unknown as Awaited<ReturnType<typeof getActivity>>)
    vi.mocked(getPlanDays).mockResolvedValue({ days: [] })

    renderActivityDetail()

    expect(await screen.findByText('Easy Run')).toBeInTheDocument()
    expect(screen.getByText('手表负荷')).toBeInTheDocument()
    expect(screen.getByText('STRIDE 客观负荷')).toBeInTheDocument()
    expect(screen.getByText('训练剂量')).toBeInTheDocument()
    expect(screen.getByText('86.4')).toBeInTheDocument()
    expect(screen.getByText('gps_ok')).toBeInTheDocument()
  })
})
