import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { getAllActivities, type Activity } from '../../api'
import { UserContext } from '../../UserContextValue'
import ActivitiesPage from '../ActivitiesPage'

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    getAllActivities: vi.fn(),
    formatDateShort: (value: string) => value.slice(5, 10),
    sportNameCN: (value: string) => value,
  }
})

vi.mock('../../lib/shanghai', async () => {
  const actual = await vi.importActual<typeof import('../../lib/shanghai')>('../../lib/shanghai')
  return {
    ...actual,
    shanghaiToday: () => '2026-05-08',
  }
})

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    label_id: overrides.label_id ?? 'activity-1',
    name: overrides.name ?? 'Activity',
    sport_type: overrides.sport_type ?? 100,
    sport_name: overrides.sport_name ?? 'Run',
    date: overrides.date ?? '2026-05-08T06:00:00+08:00',
    distance_m: overrides.distance_m ?? 10000,
    distance_km: overrides.distance_km ?? 10,
    duration_s: overrides.duration_s ?? 3000,
    duration_fmt: overrides.duration_fmt ?? '00:50:00',
    avg_pace_s_km: overrides.avg_pace_s_km ?? 300,
    pace_fmt: overrides.pace_fmt ?? '5:00/km',
    avg_hr: overrides.avg_hr ?? 145,
    max_hr: overrides.max_hr ?? 170,
    avg_cadence: overrides.avg_cadence ?? 180,
    calories_kcal: overrides.calories_kcal ?? 500,
    training_load: overrides.training_load ?? 120,
    vo2max: overrides.vo2max ?? null,
    train_type: overrides.train_type ?? null,
    ascent_m: overrides.ascent_m ?? null,
    aerobic_effect: overrides.aerobic_effect ?? null,
    anaerobic_effect: overrides.anaerobic_effect ?? null,
    temperature: overrides.temperature ?? null,
    humidity: overrides.humidity ?? null,
    feels_like: overrides.feels_like ?? null,
    wind_speed: overrides.wind_speed ?? null,
    feel_type: overrides.feel_type ?? null,
    sport_note: overrides.sport_note ?? null,
    pauses: overrides.pauses ?? [],
    route_thumb: overrides.route_thumb ?? null,
  }
}

const defaultActivities = [
  makeActivity({ label_id: 'run10', name: 'Morning Run 10K', date: '2026-05-08T06:00:00+08:00', distance_km: 10, distance_m: 10000 }),
  makeActivity({ label_id: 'run5', name: 'Easy Run 5K', date: '2026-05-07T06:00:00+08:00', distance_km: 5, distance_m: 5000 }),
  makeActivity({
    label_id: 'strength-a',
    name: 'Strength A',
    sport_type: 402,
    sport_name: 'Strength Training',
    date: '2026-05-06T19:00:00+08:00',
    distance_km: 0,
    distance_m: 0,
    avg_pace_s_km: null,
    pace_fmt: '--',
    avg_cadence: null,
  }),
  makeActivity({ label_id: 'april-run', name: 'April Run', date: '2026-04-28T06:00:00+08:00', distance_km: 12, distance_m: 12000 }),
]

function renderActivitiesPage(path = '/activities') {
  return render(
    <UserContext.Provider value={{ user: 'user-1', displayName: 'Test User', refresh: async () => {} }}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/activities" element={<ActivitiesPage />} />
          <Route path="/activity/:id" element={<div>Activity detail route</div>} />
        </Routes>
      </MemoryRouter>
    </UserContext.Provider>,
  )
}

describe('ActivitiesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAllActivities).mockImplementation((_user, opts) => {
      if (opts?.dateFrom === '2026-05-01' && opts.dateTo === '2026-05-31') {
        return Promise.resolve(defaultActivities.filter(activity => activity.date.startsWith('2026-05')))
      }
      return Promise.resolve(defaultActivities)
    })
  })

  it('renders the activity list shell, monthly summary, filters, and month groups', async () => {
    renderActivitiesPage()

    expect(await screen.findByRole('heading', { name: '活动列表' })).toBeInTheDocument()
    expect(screen.getByText('活动记录 · 全部')).toBeInTheDocument()
    expect(screen.getByText('本月统计 · 2026 年 5 月')).toBeInTheDocument()
    expect(screen.getByText('类型 · 全部')).toBeInTheDocument()
    expect(screen.getByText('距离 · 全部')).toBeInTheDocument()
    expect(screen.getAllByText('2026 年 5 月').length).toBeGreaterThan(0)
    expect(screen.getByText('2026 年 4 月')).toBeInTheDocument()
  })

  it('filters by sport and distance on the frontend only', async () => {
    renderActivitiesPage()

    expect(await screen.findByText('Morning Run 10K')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('活动类型'), { target: { value: 'strength' } })
    expect(screen.getByText('Strength A')).toBeInTheDocument()
    expect(screen.queryByText('Morning Run 10K')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('活动类型'), { target: { value: 'run' } })
    fireEvent.change(screen.getByLabelText('距离下限'), { target: { value: '10' } })
    expect(screen.getByText('Morning Run 10K')).toBeInTheDocument()
    expect(screen.queryByText('Easy Run 5K')).not.toBeInTheDocument()
    expect(getAllActivities).not.toHaveBeenCalledWith('user-1', expect.objectContaining({ sport: 'run' }))
  })

  it('applies a custom date range through the API helper', async () => {
    renderActivitiesPage()

    expect(await screen.findByText('Morning Run 10K')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-04-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-04-30' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))

    await waitFor(() => expect(getAllActivities).toHaveBeenCalledWith('user-1', {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
    }))
  })

  it('paginates activities and links rows to activity detail', async () => {
    vi.mocked(getAllActivities).mockResolvedValue(Array.from({ length: 13 }, (_, index) => (
      makeActivity({ label_id: `run-${index}`, name: `Run ${index}`, date: '2026-05-08T06:00:00+08:00' })
    )))

    renderActivitiesPage()

    expect(await screen.findByText('Run 0')).toBeInTheDocument()
    expect(screen.queryByText('Run 12')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('Run 12')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Run 12'))
    expect(screen.getByText('Activity detail route')).toBeInTheDocument()
  })

  it('shows an empty state when filters remove all activities', async () => {
    renderActivitiesPage()

    expect(await screen.findByText('Morning Run 10K')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('距离下限'), { target: { value: '40' } })

    expect(screen.getByText('该范围暂无活动记录。')).toBeInTheDocument()
  })
})
