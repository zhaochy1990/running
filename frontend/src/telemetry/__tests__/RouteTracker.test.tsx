import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import RouteTracker from '../RouteTracker'

const trackPageView = vi.fn()

vi.mock('../appInsights', () => ({
  trackPageView: (...args: unknown[]) => trackPageView(...args),
  setAuthUser: vi.fn(),
  clearAuthUser: vi.fn(),
  getAppInsights: vi.fn(),
}))

const hydratedRef = { current: true }

vi.mock('../../store/authStore', () => ({
  useAuthStore: <T,>(selector: (s: { hydrated: boolean }) => T): T =>
    selector({ hydrated: hydratedRef.current }),
}))

function Probe({ to }: { to: string }) {
  const navigate = useNavigate()
  useEffect(() => {
    navigate(to)
  }, [to, navigate])
  return null
}

beforeEach(() => {
  trackPageView.mockReset()
  hydratedRef.current = true
  cleanup()
})

describe('RouteTracker', () => {
  it('emits trackPageView with the mapped route name on initial render', () => {
    render(
      <MemoryRouter initialEntries={['/health']}>
        <RouteTracker />
        <Routes>
          <Route path="/health" element={<div>health</div>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(trackPageView).toHaveBeenCalledWith('Health', '/health')
  })

  it('collapses parameterized routes to a single name', () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/activity/abc123']}>
        <RouteTracker />
      </MemoryRouter>,
    )
    expect(trackPageView).toHaveBeenLastCalledWith('Activity Detail', '/activity/abc123')
    unmount()

    render(
      <MemoryRouter initialEntries={['/activity/xyz789']}>
        <RouteTracker />
      </MemoryRouter>,
    )
    expect(trackPageView).toHaveBeenLastCalledWith('Activity Detail', '/activity/xyz789')
  })

  it('emits a new event on each navigation', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <RouteTracker />
        <Probe to="/plan" />
      </MemoryRouter>,
    )
    expect(trackPageView).toHaveBeenCalledWith('Home', '/')
    expect(trackPageView).toHaveBeenCalledWith('Training Plan', '/plan')
  })

  it('does not emit when hydrated is false (race fix per Critic #4)', () => {
    hydratedRef.current = false
    render(
      <MemoryRouter initialEntries={['/health']}>
        <RouteTracker />
      </MemoryRouter>,
    )
    expect(trackPageView).not.toHaveBeenCalled()
  })
})
