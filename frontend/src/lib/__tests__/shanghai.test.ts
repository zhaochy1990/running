import { describe, it, expect } from 'vitest'
import {
  shanghaiDate,
  shanghaiMonthDay,
  shanghaiTime,
  shanghaiTimeShort,
  shanghaiToday,
  shanghaiWeekday,
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
