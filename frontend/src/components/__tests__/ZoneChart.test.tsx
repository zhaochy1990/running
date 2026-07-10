import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Zone } from '../../api'
import ZoneChart from '../ZoneChart'

function pace(zone_index: number, range_min: number | null, range_max: number | null): Zone {
  return { zone_type: 'pace', zone_index, range_min, range_max, range_unit: 'pace', duration_s: 0, percent: 0 }
}

function hr(zone_index: number, range_min: number | null, range_max: number | null): Zone {
  return { zone_type: 'heartRate', zone_index, range_min, range_max, range_unit: 'bpm', duration_s: 0, percent: 0 }
}

// STRIDE-derived zones leave the outer edges open (recovery has no slow bound,
// the fastest zone no fast bound). These tests pin the open-edge rendering that
// the prod-only smoke can't reach, plus the closed-bound path for pre-rollout
// provider rows. Pace bounds are ms/km (range_min = faster edge); HR is bpm.
describe('ZoneChart pace open edges', () => {
  it('renders open recovery/repetition edges and a closed middle zone', () => {
    const zones = [
      pace(1, 347222, null),    // recovery: open slow edge → "> 5:47"
      pace(2, 297619, 347222),  // easy: closed → "4:58–5:47"
      pace(6, null, 225000),    // repetition: open fast edge → "< 3:45"
    ]
    const text = render(<ZoneChart zones={zones} type="pace" />).container.textContent ?? ''
    expect(text).toContain('> 5:47/km')
    expect(text).toContain('< 3:45/km')
    expect(text).toContain('4:58')
    expect(text).toContain('5:47')
  })
})

describe('ZoneChart HR open edges', () => {
  it('renders open low/high edges and a closed middle zone', () => {
    const zones = [
      hr(1, null, 135),  // recovery: open low edge → "< 135"
      hr(2, 135, 148),   // easy: closed → "135–148"
      hr(6, 179, null),  // repetition (fastest shown): open high edge → "≥ 179"
    ]
    const text = render(<ZoneChart zones={zones} type="hr" />).container.textContent ?? ''
    expect(text).toContain('< 135 bpm')
    expect(text).toContain('≥ 179 bpm')
    expect(text).toContain('135')
    expect(text).toContain('148')
  })
})
