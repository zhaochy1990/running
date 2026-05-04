import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import WeeklyIntensityCard from '../WeeklyIntensityCard'

describe('WeeklyIntensityCard', () => {
  it('returns null when no summary is provided', () => {
    const { container } = render(<WeeklyIntensityCard summary={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders three stats with computed percentages when zone data present', () => {
    render(
      <WeeklyIntensityCard
        summary={{
          total_run_km: 40,
          low_km: 28,
          mid_km: 8,
          high_km: 4,
          has_zone_data: true,
        }}
      />,
    )
    const card = screen.getByTestId('weekly-intensity-card')
    expect(card).toHaveTextContent('本周跑量')
    expect(card).toHaveTextContent('40.0 km')
    expect(card).toHaveTextContent('低强度 Z1+Z2')
    expect(card).toHaveTextContent('28.0 km')
    expect(card).toHaveTextContent('70%')
    expect(card).toHaveTextContent('高强度 Z4+Z5')
    expect(card).toHaveTextContent('4.0 km')
    expect(card).toHaveTextContent('10%')
  })

  it('renders fallback note + dashes when has_zone_data=false but km > 0', () => {
    render(
      <WeeklyIntensityCard
        summary={{
          total_run_km: 12,
          low_km: null,
          mid_km: null,
          high_km: null,
          has_zone_data: false,
        }}
      />,
    )
    expect(screen.getByText(/尚无心率分区数据/)).toBeInTheDocument()
    const card = screen.getByTestId('weekly-intensity-card')
    expect(card).toHaveTextContent('12.0 km')
    // Both low/high cells fall back to em-dash, no percentage suffix.
    expect(card.textContent).not.toMatch(/\d+%/)
  })

  it('renders 0.0 km on an empty week without showing zone fallback note', () => {
    render(
      <WeeklyIntensityCard
        summary={{
          total_run_km: 0,
          low_km: null,
          mid_km: null,
          high_km: null,
          has_zone_data: false,
        }}
      />,
    )
    expect(screen.getByTestId('weekly-intensity-card')).toBeInTheDocument()
    // Empty week: no point telling the user "尚无心率分区数据" — they have no
    // runs to begin with.
    expect(screen.queryByText(/尚无心率分区数据/)).not.toBeInTheDocument()
  })
})
