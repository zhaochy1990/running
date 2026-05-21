import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import * as api from '../../api'
import { UserContext } from '../../UserContextValue'
import TrainingStatusPage from '../TrainingStatusPage'

vi.mock('recharts', () => {
  const NullChartElement = () => null
  return {
    ResponsiveContainer: NullChartElement,
    AreaChart: NullChartElement,
    Area: NullChartElement,
    LineChart: NullChartElement,
    Line: NullChartElement,
    XAxis: NullChartElement,
    YAxis: NullChartElement,
    Tooltip: NullChartElement,
    CartesianGrid: NullChartElement,
    Legend: NullChartElement,
  }
})

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof api>('../../api')
  return {
    ...actual,
    getHealth: vi.fn(),
    getHrv: vi.fn(),
    getStrideZones: vi.fn(),
    getStrideTrainingLoad: vi.fn(),
  }
})

const USER = '00000000-0000-4000-8000-000000000001'

function renderPage() {
  return render(
    <MemoryRouter>
      <UserContext.Provider value={{ user: USER, displayName: 'Test User', refresh: async () => {} }}>
        <TrainingStatusPage />
      </UserContext.Provider>
    </MemoryRouter>,
  )
}

const happyZones: api.StrideZonesResponse = {
  threshold: {
    speed_mps: 4.65,
    pace_per_km_sec: 215,
    hr_bpm: 175,
    speed_confidence: 'medium',
    hr_confidence: 'medium',
    as_of_date: '2026-05-15',
    calibration_id: 1,
  },
  pace_zones: [
    { name: 'Z1', label: '轻松', lower_pace: '6:42', upper_pace: '5:58' },
    { name: 'Z2', label: '有氧', lower_pace: '5:58', upper_pace: '5:06' },
    { name: 'Z3', label: '节奏', lower_pace: '5:06', upper_pace: '4:36' },
    { name: 'Z4', label: '阈值', lower_pace: '4:36', upper_pace: '4:18' },
    { name: 'Z5', label: 'VO2max', lower_pace: '4:18', upper_pace: '3:52' },
  ],
  hr_zones: [
    { name: 'Z1', label: '恢复', lower_bpm: 105, upper_bpm: 140 },
    { name: 'Z2', label: '有氧', lower_bpm: 140, upper_bpm: 154 },
    { name: 'Z3', label: '节奏', lower_bpm: 154, upper_bpm: 165 },
    { name: 'Z4', label: '阈值', lower_bpm: 165, upper_bpm: 175 },
    { name: 'Z5', label: 'VO2max', lower_bpm: 175, upper_bpm: 188 },
  ],
}

const happyLoad: api.StrideTrainingLoadResponse = {
  current: {
    date: '2026-05-21', algorithm_version: 1, training_dose: 75.2,
    acute_load: 78, chronic_load: 72, form: -6, load_ratio: 1.08,
    readiness_gate: 'go', readiness_reasons: ['ok'],
  },
  series: [
    { date: '2026-05-17', algorithm_version: 1, training_dose: 60, acute_load: 70, chronic_load: 70, form: 0, load_ratio: 1.0, readiness_gate: 'go', readiness_reasons: [] },
    { date: '2026-05-21', algorithm_version: 1, training_dose: 75.2, acute_load: 78, chronic_load: 72, form: -6, load_ratio: 1.08, readiness_gate: 'go', readiness_reasons: [] },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getHealth).mockResolvedValue({
    health: [{ date: '20260521', rhr: 47 } as any],
    hrv: {} as any,
    rhr_baseline: 49,
  })
  vi.mocked(api.getHrv).mockResolvedValue({
    hrv: [{ date: '2026-05-21', last_night_avg: 62 } as any],
    summary: {} as any,
  })
  vi.mocked(api.getStrideZones).mockResolvedValue(happyZones)
  vi.mocked(api.getStrideTrainingLoad).mockResolvedValue(happyLoad)
})

describe('TrainingStatusPage', () => {
  it('renders all sections on happy path', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())

    // Metric cards
    expect(screen.getByText('47')).toBeInTheDocument()   // RHR
    expect(screen.getByText('62')).toBeInTheDocument()   // HRV
    expect(screen.getByText('3:35')).toBeInTheDocument() // threshold pace: 215s/km = 3min 35sec
    // 175 appears in metric card + HR zone table boundaries; just confirm it's present
    expect(screen.getAllByText('175').length).toBeGreaterThan(0)  // threshold HR

    // Zone tables — Z1 appears in both pace + HR zone tables
    expect(screen.getAllByText('Z1').length).toBe(2)
    expect(screen.getByText('轻松')).toBeInTheDocument()
    expect(screen.getByText('恢复')).toBeInTheDocument()

    // Training load stats
    expect(screen.getByText('Acute')).toBeInTheDocument()
    expect(screen.getByText('78.0')).toBeInTheDocument()

    // Footer contains calibration date
    expect(screen.getByText(/2026-05-15/)).toBeInTheDocument()
  })

  it('shows empty-state when zones threshold is null', async () => {
    vi.mocked(api.getStrideZones).mockResolvedValue({
      threshold: null, pace_zones: [], hr_zones: [],
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    expect(screen.getAllByText(/暂无 STRIDE 校准数据/).length).toBeGreaterThan(0)
  })

  it('shows empty-state when training load is empty', async () => {
    vi.mocked(api.getStrideTrainingLoad).mockResolvedValue({
      current: null, series: [],
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    expect(screen.getByText('暂无训练负荷数据')).toBeInTheDocument()
  })

  it('refetches training-load on time-range toggle', async () => {
    renderPage()
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledWith(USER, 30))

    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledWith(USER, 90))
  })

  it('does not display COROS pass-through fields from /health', async () => {
    vi.mocked(api.getHealth).mockResolvedValue({
      health: [{ date: '20260521', rhr: 47, ati: 99, cti: 99, tsb: 99 } as any],
      hrv: {} as any,
      rhr_baseline: 49,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    // 99 should NOT appear — it's the COROS ATI/CTI/TSB value the page must not render
    expect(screen.queryByText('99')).not.toBeInTheDocument()
  })
})
