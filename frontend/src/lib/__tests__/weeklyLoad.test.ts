import { describe, it, expect } from 'vitest'
import { aggregateWeeklyDose, type DailyDoseRow } from '../weeklyLoad'

function rec(
  date: string, dose: number | null, coverage_status: string = 'complete',
): DailyDoseRow {
  return { date, training_dose: dose, coverage_status }
}

// Anchor: 2026-05-24 is a Sunday in Shanghai → its week starts Mon 2026-05-18.
// 8-week window ending on the 5/18 week: 3/30, 4/6, 4/13, 4/20, 4/27, 5/4, 5/11, 5/18.
const TODAY = '2026-05-24'

describe('aggregateWeeklyDose', () => {
  it('returns exactly 8 buckets, oldest first', () => {
    const out = aggregateWeeklyDose([], TODAY)
    expect(out).toHaveLength(8)
    expect(out[0].weekStart).toBe('2026-03-30')
    expect(out[7].weekStart).toBe('2026-05-18')
  })

  it('renders weeks with no observed coverage as gaps', () => {
    const out = aggregateWeeklyDose([], TODAY)
    for (const b of out) {
      expect(b.totalDose).toBeNull()
      expect(b.activeDays).toBe(0)
    }
  })

  it('sums doses falling in the same Shanghai week', () => {
    const out = aggregateWeeklyDose([
      rec('2026-05-20', 30),
      rec('2026-05-21', 45),
      rec('2026-05-22', 60),
    ], TODAY)
    const thisWeek = out[7]
    expect(thisWeek.weekStart).toBe('2026-05-18')
    expect(thisWeek.totalDose).toBeCloseTo(135)
    expect(thisWeek.activeDays).toBe(3)
  })

  it('attributes Sunday to the current week (not the next)', () => {
    // 2026-05-24 is the Sunday of the 5/18 week — must stay in that bucket.
    const out = aggregateWeeklyDose([rec('2026-05-24', 100)], TODAY)
    expect(out[7].totalDose).toBe(100)
    expect(out[7].activeDays).toBe(1)
  })

  it('attributes Monday to the new week', () => {
    // 2026-05-18 is the Monday → opens its own bucket.
    const out = aggregateWeeklyDose([rec('2026-05-18', 50)], TODAY)
    expect(out[7].weekStart).toBe('2026-05-18')
    expect(out[7].totalDose).toBe(50)
    expect(out[6].totalDose).toBeNull()  // previous week has no observed coverage
  })

  it('drops records outside the 8-week window', () => {
    const out = aggregateWeeklyDose([
      rec('2026-03-29', 999),    // Sunday in week of 3/23 — one week before window
      rec('2026-05-25', 999),    // next Monday — already after current week
    ], TODAY)
    for (const b of out) {
      expect(b.totalDose).toBeNull()
    }
  })

  it('ignores records with null training_dose', () => {
    const out = aggregateWeeklyDose([rec('2026-05-20', null)], TODAY)
    expect(out[7].totalDose).toBeNull()
    expect(out[7].activeDays).toBe(0)
  })

  it('handles UTC ISO dates that cross the Shanghai day boundary', () => {
    // 2026-05-24T17:00:00Z == 2026-05-25 01:00 Shanghai (Monday → next week,
    // outside the window). Dose must NOT leak into the 5/18 bucket.
    const out = aggregateWeeklyDose([
      rec('2026-05-24T17:00:00+00:00', 200),
    ], TODAY)
    expect(out[7].totalDose).toBeNull()
  })

  it('uses M/D Monday for weekLabel', () => {
    const out = aggregateWeeklyDose([], TODAY)
    expect(out[7].weekLabel).toBe('5/18')
    expect(out[0].weekLabel).toBe('3/30')
  })

  it('counts only days with positive dose as active', () => {
    const out = aggregateWeeklyDose([
      rec('2026-05-19', 0),
      rec('2026-05-20', 25),
      rec('2026-05-21', 0),
    ], TODAY)
    expect(out[7].totalDose).toBeCloseTo(25)
    expect(out[7].activeDays).toBe(1)
  })

  it('renders a week containing an unknown placeholder as a gap', () => {
    const out = aggregateWeeklyDose([
      rec('2026-05-19', 50),
      rec('2026-05-20', 0, 'unknown'),
    ], TODAY)

    expect(out[7].totalDose).toBeNull()
    expect(out[7].activeDays).toBe(1)
  })
})
