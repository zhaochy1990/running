import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import * as api from '../../api'
import { UserContext } from '../../UserContextValue'
import TrainingStatusPage, { ActivityHeatmap, heatmapBucket } from '../TrainingStatusPage'

vi.mock('recharts', () => {
  const NullChartElement = () => null
  return {
    ResponsiveContainer: NullChartElement,
    AreaChart: NullChartElement,
    Area: NullChartElement,
    BarChart: NullChartElement,
    Bar: NullChartElement,
    Cell: NullChartElement,
    ComposedChart: NullChartElement,
    LineChart: NullChartElement,
    Line: NullChartElement,
    XAxis: NullChartElement,
    YAxis: NullChartElement,
    Tooltip: NullChartElement,
    CartesianGrid: NullChartElement,
    Legend: NullChartElement,
    ReferenceLine: NullChartElement,
    ReferenceArea: NullChartElement,
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
    getAllActivitiesInRange: vi.fn(),
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
    { name: 'recovery',   label: '配速1区', lower_pace: null,   upper_pace: '6:42' },
    { name: 'easy',       label: '配速2区', lower_pace: '6:42', upper_pace: '5:58' },
    { name: 'marathon',   label: '配速3区', lower_pace: '5:58', upper_pace: '5:06' },
    { name: 'threshold',  label: '配速4区', lower_pace: '5:06', upper_pace: '4:36' },
    { name: 'interval',   label: '配速5区', lower_pace: '4:36', upper_pace: '4:18' },
    { name: 'repetition', label: '配速6区', lower_pace: '4:18', upper_pace: null },
  ],
  hr_zones: [
    { name: 'recovery',   label: '心率1区', lower_bpm: null, upper_bpm: 140 },
    { name: 'easy',       label: '心率2区', lower_bpm: 140,  upper_bpm: 154 },
    { name: 'marathon',   label: '心率3区', lower_bpm: 154,  upper_bpm: 165 },
    { name: 'threshold',  label: '心率4区', lower_bpm: 165,  upper_bpm: 175 },
    { name: 'interval',   label: '心率5区', lower_bpm: 175,  upper_bpm: 188 },
    { name: 'repetition', label: '心率6区', lower_bpm: 188,  upper_bpm: null },
  ],
}

const happyLoad: api.StrideTrainingLoadResponse = {
  current: {
    date: '2026-05-21', algorithm_version: 1, training_dose: 75.2,
    acute_load: 78, chronic_load: 72, form: -6, load_ratio: 1.08,
    coverage_status: 'complete',
    readiness_gate: 'green', readiness_reasons: ['ok'],
  },
  series: [
    { date: '2026-05-17', algorithm_version: 1, training_dose: 60, acute_load: 70, chronic_load: 70, form: 0, load_ratio: 1.0, coverage_status: 'complete', readiness_gate: 'green', readiness_reasons: [] },
    { date: '2026-05-21', algorithm_version: 1, training_dose: 75.2, acute_load: 78, chronic_load: 72, form: -6, load_ratio: 1.08, coverage_status: 'complete', readiness_gate: 'green', readiness_reasons: [] },
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
  vi.mocked(api.getAllActivitiesInRange).mockResolvedValue([])
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

    // Zone tables: 6 rows per table, named recovery..repetition, labelled
    // "配速N区" / "心率N区". "recovery" appears in both pace + HR tables.
    expect(screen.getAllByText('recovery').length).toBe(2)
    expect(screen.getByText('配速1区')).toBeInTheDocument()
    expect(screen.getByText('心率1区')).toBeInTheDocument()

    // Training load stats
    expect(screen.getByText('急性负荷(Acute)')).toBeInTheDocument()
    expect(screen.getByText('78.0')).toBeInTheDocument()

    // Dose stat (added in follow-up polish)
    expect(screen.getByText('训练负荷(Dose)')).toBeInTheDocument()
    expect(screen.getByText('75')).toBeInTheDocument() // training_dose 75.2 → toFixed(0)

    // Readiness gate is now color-pilled with Chinese label
    expect(screen.getByText(/绿灯 · 可进行强度训练/)).toBeInTheDocument()

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
    // Initial window is 30d, but the 16-week heatmap needs ≥ 112 days, so
    // the fetch is clamped to max(window, 112).
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledWith(USER, 112))

    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    // 90 < 112 so the value stays 112; assert call count to prove a refetch
    // actually fired (otherwise the second waitFor is satisfied by the first call).
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledTimes(2))
    expect(api.getStrideTrainingLoad).toHaveBeenLastCalledWith(USER, 112)
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

  it('renders the 16-week heatmap alongside the 8-week trend', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    // Heatmap title is present
    expect(screen.getByText('16 周训练热力图 · 16-Week Activity Heatmap')).toBeInTheDocument()
    // Heatmap renders 112 cells regardless of empty dose series
    const cells = container.querySelectorAll('rect.heatmap-cell')
    expect(cells.length).toBe(112)
  })
})

describe('heatmapBucket', () => {
  it('returns 0 for null / 0 / negative', () => {
    expect(heatmapBucket(null)).toBe(0)
    expect(heatmapBucket(0)).toBe(0)
    expect(heatmapBucket(-5)).toBe(0)
  })
  it('returns 1 for 1..40', () => {
    expect(heatmapBucket(1)).toBe(1)
    expect(heatmapBucket(40)).toBe(1)
  })
  it('returns 2 for 41..80', () => {
    expect(heatmapBucket(41)).toBe(2)
    expect(heatmapBucket(80)).toBe(2)
  })
  it('returns 3 for 81..120', () => {
    expect(heatmapBucket(81)).toBe(3)
    expect(heatmapBucket(120)).toBe(3)
  })
  it('returns 4 for >120', () => {
    expect(heatmapBucket(121)).toBe(4)
    expect(heatmapBucket(500)).toBe(4)
  })
})

describe('ActivityHeatmap', () => {
  // Stable today for deterministic rendering. The page itself uses
  // shanghaiToday(), so we mock the system clock to a known Shanghai
  // Wednesday (2026-05-27). Container's week-Monday = 2026-05-25,
  // so cell column 15 spans 2026-05-25 .. 2026-05-31; today is column 15
  // row 2 (Wed), and 2026-05-28 .. 2026-05-31 are future.
  beforeEach(() => {
    vi.useFakeTimers()
    // 2026-05-27T08:00:00+08:00 = 2026-05-27T00:00:00Z (Shanghai Wed)
    vi.setSystemTime(new Date('2026-05-27T00:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders 112 cell rects across 16 weeks × 7 days', () => {
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={[]}
        activitiesByDate={new Map()}
      />,
    )
    // Each <rect> with class 'heatmap-cell' is one day cell.
    const cells = container.querySelectorAll('rect.heatmap-cell')
    expect(cells.length).toBe(112)
  })

  it('colors cells by dose bucket', () => {
    const series: any[] = [
      { date: '2026-05-20', training_dose: 0,   algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-21', training_dose: 30,  algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-22', training_dose: 60,  algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-23', training_dose: 100, algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
      { date: '2026-05-24', training_dose: 150, algorithm_version: 1, acute_load: 0, chronic_load: 0, form: 0, load_ratio: 0, readiness_gate: 'green', readiness_reasons: [] },
    ]
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={series}
        activitiesByDate={new Map()}
      />,
    )
    // Pull cells indexed by data-date attribute.
    const cellAt = (date: string) =>
      container.querySelector(`rect.heatmap-cell[data-date="${date}"]`)
    expect(cellAt('2026-05-20')?.getAttribute('fill')).toBe('#f0f1f4')  // bucket 0
    expect(cellAt('2026-05-21')?.getAttribute('fill')).toBe('#fed7aa')  // bucket 1
    expect(cellAt('2026-05-22')?.getAttribute('fill')).toBe('#fdba74')  // bucket 2
    expect(cellAt('2026-05-23')?.getAttribute('fill')).toBe('#fb923c')  // bucket 3
    expect(cellAt('2026-05-24')?.getAttribute('fill')).toBe('#c2410c')  // bucket 4
  })

  it('marks future days with dashed stroke and transparent fill', () => {
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={[]}
        activitiesByDate={new Map()}
      />,
    )
    // 2026-05-28 is Thursday, the day after the fake "today" (2026-05-27 Wed).
    const future = container.querySelector('rect.heatmap-cell[data-date="2026-05-28"]')
    expect(future).not.toBeNull()
    expect(future?.getAttribute('fill')).toBe('transparent')
    expect(future?.getAttribute('stroke-dasharray')).toBe('2 2')
  })

  it('marks today with a dark stroke', () => {
    const { container } = render(
      <ActivityHeatmap
        weeks={16}
        series={[]}
        activitiesByDate={new Map()}
      />,
    )
    const today = container.querySelector('rect.heatmap-cell[data-date="2026-05-27"]')
    expect(today).not.toBeNull()
    expect(today?.getAttribute('stroke')).toBe('#1a1c2e')
  })
})
