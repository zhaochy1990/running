import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { getActivities, getAllActivities, type Activity } from '../../api'
import { useNotificationsStore } from '../../store/notificationsStore'
import { UserContext } from '../../UserContextValue'
import ActivitiesPage from '../ActivitiesPage'

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    getActivities: vi.fn(),
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
    useNotificationsStore.setState({
      readIds: new Set(),
      serverNotifications: [],
      loadState: 'idle',
      error: null,
    })
    vi.mocked(getActivities).mockImplementation((_user, opts) => {
      let activities = [...defaultActivities]
      if (opts?.dateFrom) activities = activities.filter(activity => activity.date.slice(0, 10) >= opts.dateFrom!)
      if (opts?.dateTo) activities = activities.filter(activity => activity.date.slice(0, 10) <= opts.dateTo!)
      if (opts?.sportCategory === 'run') activities = activities.filter(activity => activity.sport_name.includes('Run'))
      if (opts?.sportCategory === 'strength') activities = activities.filter(activity => activity.sport_name.includes('Strength'))
      if (opts?.minDistanceKm) activities = activities.filter(activity => activity.distance_km >= opts.minDistanceKm!)
      const offset = opts?.offset ?? 0
      const limit = opts?.limit ?? 12
      return Promise.resolve({
        total: activities.length,
        offset,
        limit,
        activities: activities.slice(offset, offset + limit),
      })
    })
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
    expect(getActivities).toHaveBeenCalledWith('user-1', { limit: 25, offset: 0 })
    expect(getAllActivities).toHaveBeenCalledWith('user-1', {
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
    })
  })

  it('requests sport and distance filters from the activity endpoint', async () => {
    renderActivitiesPage()

    expect(await screen.findByText('Morning Run 10K')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('活动类型'), { target: { value: 'strength' } })
    await waitFor(() => expect(getActivities).toHaveBeenCalledWith('user-1', {
      limit: 25,
      offset: 0,
      sportCategory: 'strength',
    }))
    expect(await screen.findByText('Strength A')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('活动类型'), { target: { value: 'run' } })
    fireEvent.change(screen.getByLabelText('距离下限'), { target: { value: '10' } })
    await waitFor(() => expect(getActivities).toHaveBeenCalledWith('user-1', {
      limit: 25,
      offset: 0,
      sportCategory: 'run',
      minDistanceKm: 10,
    }))
    expect(await screen.findByText('Morning Run 10K')).toBeInTheDocument()
  })

  it('applies a custom date range through the API helper', async () => {
    renderActivitiesPage()

    expect(await screen.findByText('Morning Run 10K')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-04-01' } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-04-30' } })
    fireEvent.click(screen.getByRole('button', { name: '应用' }))

    await waitFor(() => expect(getActivities).toHaveBeenCalledWith('user-1', {
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
      limit: 25,
      offset: 0,
    }))
  })

  it('requests pages from the server with compact pagination and links rows to activity detail', async () => {
    const activities = Array.from({ length: 2050 }, (_, index) => (
      makeActivity({ label_id: `run-${index}`, name: `Run ${index}`, date: '2026-05-08T06:00:00+08:00' })
    ))
    vi.mocked(getActivities).mockImplementation((_user, opts) => {
      const offset = opts?.offset ?? 0
      const limit = opts?.limit ?? 25
      return Promise.resolve({
        total: activities.length,
        offset,
        limit,
        activities: activities.slice(offset, offset + limit),
      })
    })
    vi.mocked(getAllActivities).mockResolvedValue(activities.slice(0, 25))

    renderActivitiesPage()

    expect(await screen.findByText('Run 0')).toBeInTheDocument()
    expect(screen.queryByText('Run 25')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '82' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '40' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    await waitFor(() => expect(getActivities).toHaveBeenCalledWith('user-1', { limit: 25, offset: 25 }))
    expect(await screen.findByText('Run 25')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Run 25'))
    expect(screen.getByText('Activity detail route')).toBeInTheDocument()
  })

  it('renders whole-month totals from the server when a month spans pages', async () => {
    const activities = [
      makeActivity({ label_id: 'may-1', name: 'May Run 1', date: '2026-05-10T06:00:00+08:00', distance_km: 10, duration_s: 3000 }),
      makeActivity({ label_id: 'may-2', name: 'May Run 2', date: '2026-05-09T06:00:00+08:00', distance_km: 5, duration_s: 1500 }),
      makeActivity({ label_id: 'may-3', name: 'May Run 3', date: '2026-05-08T06:00:00+08:00', distance_km: 7, duration_s: 2100 }),
      makeActivity({ label_id: 'may-4', name: 'May Run 4', date: '2026-05-07T06:00:00+08:00', distance_km: 5, duration_s: 1500 }),
    ]
    vi.mocked(getActivities).mockResolvedValue({
      total: activities.length,
      offset: 0,
      limit: 2,
      activities: activities.slice(0, 2),
      monthly_summaries: {
        '2026-05': { activity_count: 4, total_run_km: 27, duration_s: 8100 },
      },
    })
    vi.mocked(getAllActivities).mockResolvedValue(activities)

    renderActivitiesPage()

    expect(await screen.findByText('May Run 1')).toBeInTheDocument()
    expect(screen.getByText('4 节 · 27.0 km · 2 小时 15 分')).toBeInTheDocument()
    expect(screen.queryByText('2 节 · 15.0 km · 1 小时 15 分')).not.toBeInTheDocument()
  })

  it('lets users change rows per page and requests the new server limit', async () => {
    const activities = Array.from({ length: 60 }, (_, index) => (
      makeActivity({ label_id: `run-${index}`, name: `Run ${index}`, date: '2026-05-08T06:00:00+08:00' })
    ))
    vi.mocked(getActivities).mockImplementation((_user, opts) => {
      const offset = opts?.offset ?? 0
      const limit = opts?.limit ?? 25
      return Promise.resolve({
        total: activities.length,
        offset,
        limit,
        activities: activities.slice(offset, offset + limit),
      })
    })
    vi.mocked(getAllActivities).mockResolvedValue(activities.slice(0, 25))

    renderActivitiesPage()

    expect(await screen.findByText('Run 0')).toBeInTheDocument()
    expect(screen.getByLabelText('每页显示')).toHaveValue('25')
    expect(screen.getByRole('option', { name: '25' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '50' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '75' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '100' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '12' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('每页显示'), { target: { value: '50' } })

    await waitFor(() => expect(getActivities).toHaveBeenCalledWith('user-1', { limit: 50, offset: 0 }))
    expect(await screen.findByText('显示 1-50 / 60')).toBeInTheDocument()
    expect(screen.getByLabelText('每页显示')).toHaveValue('50')
  })

  it('shows an empty state when the server returns no matching activities', async () => {
    renderActivitiesPage()

    expect(await screen.findByText('Morning Run 10K')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('距离下限'), { target: { value: '40' } })

    await waitFor(() => expect(getActivities).toHaveBeenCalledWith('user-1', {
      limit: 25,
      offset: 0,
      minDistanceKm: 40,
    }))
    expect(await screen.findByText('该范围暂无活动记录。')).toBeInTheDocument()
  })

  it('refreshes the list when onboarding sync progress advances', async () => {
    const syncedActivity = makeActivity({ label_id: 'synced-run', name: 'Synced Run' })
    vi.mocked(getActivities)
      .mockResolvedValueOnce({ total: 0, offset: 0, limit: 25, activities: [] })
      .mockResolvedValueOnce({ total: 1, offset: 0, limit: 25, activities: [syncedActivity] })
    vi.mocked(getAllActivities)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([syncedActivity])

    renderActivitiesPage()

    expect(await screen.findByText('该范围暂无活动记录。')).toBeInTheDocument()

    act(() => {
      useNotificationsStore.setState({
        serverNotifications: [
          {
            id: 'onboarding-progress',
            title: 'STRIDE 初始化',
            body: 'STRIDE 正在同步你的数据，当前进度 25/100',
            publishedAt: '2026-05-08T00:00:00Z',
            updatedAt: '2026-05-08T00:01:00Z',
            progressPct: 15,
            metadata: { type: 'onboarding_sync', state: 'syncing' },
          },
        ],
      })
    })

    await waitFor(() => expect(getActivities).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Synced Run')).toBeInTheDocument()
  })
})
