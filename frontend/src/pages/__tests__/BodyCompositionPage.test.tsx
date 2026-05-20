import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import BodyCompositionPage from '../BodyCompositionPage'
import * as api from '../../api'

vi.mock('../../UserContextValue', () => ({
  useUser: () => ({ user: 'testuser' }),
}))

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
    ReferenceLine: NullChartElement,
    Legend: NullChartElement,
  }
})

describe('BodyCompositionPage', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getBodyComposition').mockResolvedValue({ scans: [] })
    vi.spyOn(api, 'getBodyCompositionSummary').mockResolvedValue({
      latest: null,
      deltas: null,
      checkpoints: [],
    })
  })

  it('renders an entry button next to the page header', async () => {
    render(<MemoryRouter><BodyCompositionPage /></MemoryRouter>)
    const button = await screen.findByRole('button', { name: /录入新数据/ })
    expect(button).toBeInTheDocument()
  })

  it('opens the entry modal when the button is clicked', async () => {
    render(<MemoryRouter><BodyCompositionPage /></MemoryRouter>)
    const button = await screen.findByRole('button', { name: /录入新数据/ })
    button.click()
    expect(await screen.findByRole('dialog', { name: /录入体测数据/ })).toBeInTheDocument()
  })
})
