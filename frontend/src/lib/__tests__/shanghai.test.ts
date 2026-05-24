import { describe, it, expect } from 'vitest'
import {
  shanghaiDate,
  shanghaiMonthDay,
  shanghaiTime,
  shanghaiTimeShort,
  shanghaiToday,
  shanghaiWeekday,
  shanghaiWeekStart,
} from '../shanghai'

describe('shanghaiDate', () => {
  it('crosses the day boundary correctly', () => {
    // UTC 16:30 May 8 == Shanghai 00:30 May 9
    expect(shanghaiDate('2026-05-08T16:30:00+00:00')).toBe('2026-05-09')
  })

  it('handles +08:00 input (backend post-conversion)', () => {
    expect(shanghaiDate('2026-05-09T00:30:00+08:00')).toBe('2026-05-09')
  })

  it('handles plain YYYY-MM-DD as Shanghai day', () => {
    expect(shanghaiDate('2026-05-09')).toBe('2026-05-09')
  })

  it('handles YYYYMMDD compact form', () => {
    expect(shanghaiDate('20260509')).toBe('2026-05-09')
  })

  it('returns empty for null/empty/garbage', () => {
    expect(shanghaiDate(null)).toBe('')
    expect(shanghaiDate('')).toBe('')
    expect(shanghaiDate('not-a-date')).toBe('')
  })
})

describe('shanghaiMonthDay', () => {
  it('returns MM-DD', () => {
    expect(shanghaiMonthDay('2026-05-08T16:30:00+00:00')).toBe('05-09')
  })
})

describe('shanghaiTime', () => {
  it('returns HH:MM:SS in Shanghai', () => {
    expect(shanghaiTime('2026-05-08T16:30:00+00:00')).toBe('00:30:00')
  })
})

describe('shanghaiTimeShort', () => {
  it('returns HH:MM in Shanghai', () => {
    expect(shanghaiTimeShort('2026-05-08T16:30:00+00:00')).toBe('00:30')
  })
})

describe('shanghaiToday', () => {
  it('returns YYYY-MM-DD shape', () => {
    expect(shanghaiToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('shanghaiWeekday', () => {
  it('classifies the boundary moment into the right Shanghai weekday', () => {
    // 2026-05-09 is a Saturday in Shanghai (verify by independent compute)
    // UTC 2026-05-08T16:30 is still Friday in UTC but Saturday in Shanghai.
    const out = shanghaiWeekday('2026-05-08T16:30:00+00:00')
    expect(['周日','周一','周二','周三','周四','周五','周六']).toContain(out)
    // Sanity: Shanghai 2026-05-09 == Saturday
    expect(out).toBe('周六')
  })
})

describe('shanghaiWeekStart', () => {
  it('returns the Monday for any day in the same Shanghai week', () => {
    // 2026-05-25 is a Monday in Shanghai (verified: Jan 1 2026 = Thursday,
    // +144 days lands on Monday).
    expect(shanghaiWeekStart('2026-05-25')).toBe('2026-05-25')
    expect(shanghaiWeekStart('2026-05-26')).toBe('2026-05-25') // Tue
    expect(shanghaiWeekStart('2026-05-27')).toBe('2026-05-25') // Wed
    expect(shanghaiWeekStart('2026-05-31')).toBe('2026-05-25') // Sun, still 5/25 week
  })

  it('crosses month boundary backward', () => {
    // 2026-05-03 is a Sunday → previous Monday is 2026-04-27
    expect(shanghaiWeekStart('2026-05-03')).toBe('2026-04-27')
  })

  it('resolves a UTC-late-Sunday into the correct Shanghai-Monday week', () => {
    // 2026-05-24 17:00 UTC == 2026-05-25 01:00 Shanghai (Monday).
    // Must NOT bucket into the previous week.
    expect(shanghaiWeekStart('2026-05-24T17:00:00+00:00')).toBe('2026-05-25')
  })

  it('returns empty for invalid input', () => {
    expect(shanghaiWeekStart(null)).toBe('')
    expect(shanghaiWeekStart('')).toBe('')
    expect(shanghaiWeekStart('not-a-date')).toBe('')
  })
})
