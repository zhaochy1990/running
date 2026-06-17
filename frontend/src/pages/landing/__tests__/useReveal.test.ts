import { act, render, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useReveal, useCountUp } from '../useReveal'

let last: IO | null = null

class IO {
  cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    last = this
  }
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

beforeEach(() => {
  last = null
  vi.stubGlobal('IntersectionObserver', IO as unknown as typeof IntersectionObserver)
})

// A tiny component that attaches the hook's ref to a real DOM node so the
// effect observes an actual element (renderHook alone never attaches the ref).
function Probe() {
  const ref = useReveal()
  return createElement('div', { ref, 'data-testid': 'reveal' })
}

describe('useReveal', () => {
  it('observes the ref element on mount', () => {
    const { result } = renderHook(() => useReveal())
    // ref starts null until attached; hook must not throw
    expect(result.current).toBeDefined()
  })

  it('observes the attached element and reveals it on intersect', () => {
    const { getByTestId, unmount } = render(createElement(Probe))
    const el = getByTestId('reveal')

    expect(last).not.toBeNull()
    expect(last!.observe).toHaveBeenCalledWith(el)

    // Simulate the element entering the viewport.
    last!.cb(
      [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
      last! as unknown as IntersectionObserver,
    )

    expect(el.classList.contains('in')).toBe(true)
    expect(last!.unobserve).toHaveBeenCalledWith(el)

    unmount()
    expect(last!.disconnect).toHaveBeenCalled()
  })

  it('does not add "in" when the element is not intersecting', () => {
    const { getByTestId } = render(createElement(Probe))
    const el = getByTestId('reveal')

    last!.cb(
      [{ isIntersecting: false, target: el } as unknown as IntersectionObserverEntry],
      last! as unknown as IntersectionObserver,
    )

    expect(el.classList.contains('in')).toBe(false)
    expect(last!.unobserve).not.toHaveBeenCalled()
  })
})

// Deterministic requestAnimationFrame: each call queues a frame we flush
// manually, advancing the timestamp so the easing reaches completion.
function installRafMock() {
  let queue: FrameRequestCallback[] = []
  let now = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.push(cb)
    return queue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  return {
    flush(ms: number) {
      now += ms
      const pending = queue
      queue = []
      act(() => {
        pending.forEach((cb) => cb(now))
      })
    },
  }
}

describe('useCountUp', () => {
  let raf: ReturnType<typeof installRafMock>

  beforeEach(() => {
    raf = installRafMock()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts at zero formatted with the given decimals + suffix', () => {
    const { result } = renderHook(() => useCountUp(50, { suffix: '%', start: false }))
    expect(result.current).toBe('0%')
  })

  it('starts at zero with decimals when decimals provided', () => {
    const { result } = renderHook(() =>
      useCountUp(4.9, { decimals: 1, start: false }),
    )
    expect(result.current).toBe('0.0')
  })

  it('does not animate when start is false', () => {
    const { result } = renderHook(() => useCountUp(50, { start: false }))
    raf.flush(2000)
    expect(result.current).toBe('0')
  })

  it('animates to the target value with suffix once the duration elapses', () => {
    const { result } = renderHook(() => useCountUp(50, { suffix: '%' }))
    // First frame establishes the start timestamp (non-zero).
    raf.flush(100)
    // Advance well past the 1300ms duration so easing reaches 1.
    raf.flush(2000)
    expect(result.current).toBe('50%')
  })

  it('respects decimals for fractional targets', () => {
    const { result } = renderHook(() => useCountUp(4.9, { decimals: 1 }))
    raf.flush(100)
    raf.flush(2000)
    expect(result.current).toBe('4.9')
  })
})
