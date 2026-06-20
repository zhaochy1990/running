import { describe, it, expect } from 'vitest'
import { fmtClock } from '../fmt'

describe('fmtClock', () => {
  it('formats sub-hour times as M:SS', () => {
    expect(fmtClock(210)).toBe('3:30')      // 1K PB
    expect(fmtClock(1290)).toBe('21:30')    // 5K PB
    expect(fmtClock(9)).toBe('0:09')
  })

  it('formats hour+ times as H:MM:SS', () => {
    expect(fmtClock(3600)).toBe('1:00:00')
    expect(fmtClock(7530)).toBe('2:05:30')  // HM PB
  })

  it('returns em dash for empty/invalid input', () => {
    expect(fmtClock(null)).toBe('—')
    expect(fmtClock(undefined)).toBe('—')
    expect(fmtClock(0)).toBe('—')
    expect(fmtClock(-5)).toBe('—')
  })
})
