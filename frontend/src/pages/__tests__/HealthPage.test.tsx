import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getHealth,
  getHrv,
  getPMC,
  getPlanDays,
  getWeeks,
} from '../../api'
import { UserContext } from '../../UserContextValue'
import HealthPage from '../HealthPage'

vi.mock('recharts', () => {
  const NullChartElement = () => null
  return {
    ResponsiveContainer: NullChartElement,
    AreaChart: NullChartElement,
    Area: NullChartElement,
    Line: NullChartElement,
    BarChart: NullChartElement,
    Bar: NullChartElement,
    Cell: NullChartElement,
    ComposedChart: NullChartElement,
    XAxis: NullChartElement,
    YAxis: NullChartElement,
    Tooltip: NullChartElement,
    CartesianGrid: NullChartElement,
    ReferenceLine: NullChartElement,
    ReferenceArea: NullChartElement,
    Legend: NullChartElement,
  }
})

vi.mock('../../api', () => ({
  getHealth: vi.fn(),
  getHrv: vi.fn(),
  getPMC: vi.fn(),
  getPlanDays: vi.fn(),
  getWeeks: vi.fn(),
}))

const healthRecord = {
  date: '20260519',
  ati: 30,
  cti: 45,
  rhr: 48,
  distance_m: null,
  duration_s: null,
  training_load_ratio: 0.8,
  training_load_state: 'Optimal',
  fatigue: 42,
  body_battery_high: null,
  body_battery_low: null,
  stress_avg: null,
  sleep_total_s: null,
  sleep_deep_s: null,
  sleep_light_s: null,
  sleep_rem_s: null,
  sleep_awake_s: null,
  sleep_score: null,
  respiration_avg: null,
  spo2_avg: null,
  provider: 'coros',
}

function renderHealthPage() {
  return render(
    <UserContext.Provider value={{ user: 'test-user', displayName: 'Test User', refresh: async () => {} }}>
      <HealthPage />
    </UserContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getHealth).mockResolvedValue({
    health: [healthRecord],
    hrv: {
      avg_sleep_hrv: null,
      hrv_normal_low: null,
      hrv_normal_high: null,
      recovery_pct: null,
    },
    rhr_baseline: 47,
  })
  vi.mocked(getPMC).mockResolvedValue({
    pmc: [],
    summary: {
      current_cti: null,
      current_ati: null,
      current_tsb: null,
      current_tsb_zone: null,
      current_tsb_zone_label: null,
      current_fatigue: null,
      current_rhr: null,
      ctl_ramp: null,
      date: null,
    },
  })
  vi.mocked(getHrv).mockResolvedValue({
    hrv: [],
    summary: {
      date: null,
      last_night_avg: null,
      weekly_avg: null,
      status: null,
      baseline_balanced_low: null,
      baseline_balanced_upper: null,
    },
  })
  vi.mocked(getWeeks).mockResolvedValue({
    weeks: [
      {
        folder: '2026-05-18_05-24(W1)',
        date_from: '2026-05-18',
        date_to: '2026-05-24',
        has_plan: true,
        has_feedback: false,
        has_inbody: false,
        activity_count: 1,
        total_km: 12,
        total_duration_s: 3600,
        total_duration_fmt: '1:00:00',
      },
    ],
  })
  vi.mocked(getPlanDays).mockResolvedValue({ days: [] })
})

describe('HealthPage', () => {
  it('keeps weekly compliance out of body metrics', async () => {
    renderHealthPage()

    await screen.findByText('负荷曲线与恢复状态')
    await waitFor(() => expect(getHealth).toHaveBeenCalledWith('test-user', 30))

    expect(screen.queryByText('周度依从性')).not.toBeInTheDocument()
    expect(getWeeks).not.toHaveBeenCalled()
    expect(getPlanDays).not.toHaveBeenCalled()
  })
})
