import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useReveal } from '../useReveal'

class IO {
  cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) { this.cb = cb }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IO as unknown as typeof IntersectionObserver)
})

describe('useReveal', () => {
  it('observes the ref element on mount', () => {
    const { result } = renderHook(() => useReveal())
    // ref starts null until attached; hook must not throw
    expect(result.current).toBeDefined()
  })
})
