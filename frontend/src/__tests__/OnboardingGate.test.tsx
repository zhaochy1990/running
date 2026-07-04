import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const mocks = vi.hoisted(() => ({
  isAuthenticated: true,
  getMyProfile: vi.fn(),
}))

vi.mock('../store/authStore', () => ({
  useAuthStore: (sel?: (s: { isAuthenticated: boolean; hydrate: () => void }) => unknown) => {
    const state = { isAuthenticated: mocks.isAuthenticated, hydrate: () => {} }
    return sel ? sel(state) : state
  },
}))

vi.mock('../api', () => ({ getMyProfile: mocks.getMyProfile }))

// Replace the authed dashboard subtree so a "ready" gate renders a marker
// instead of pulling up the real dashboard / more API calls.
vi.mock('../pages/WeekLayout', () => ({ default: () => <div>DASHBOARD_HOME</div> }))
vi.mock('../components/AppLayout', () => ({
  default: () => <div>DASHBOARD_HOME</div>,
}))
vi.mock('../UserContext', () => ({
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      constructor(cb: IntersectionObserverCallback) { void cb }
    } as unknown as typeof IntersectionObserver,
  )
  mocks.isAuthenticated = true
  mocks.getMyProfile.mockReset()
})

import AppRoutes from '../AppRoutes'

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>)
}

describe('OnboardingGate loading vs error', () => {
  it('shows a distinct error state (not an /onboarding redirect) when the profile fetch fails', async () => {
    mocks.getMyProfile.mockRejectedValue(new Error('API error: 503'))
    renderAt('/')
    expect(await screen.findByText(/加载失败/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    // A transient error must NOT silently drop the user into onboarding.
    expect(screen.queryByText('DASHBOARD_HOME')).not.toBeInTheDocument()
  })

  it('retries and reaches the dashboard when the profile becomes available', async () => {
    mocks.getMyProfile
      .mockRejectedValueOnce(new Error('API error: 503'))
      .mockResolvedValueOnce({ onboarding: { completed_at: '2026-01-01T00:00:00Z' } })
    renderAt('/')
    const retry = await screen.findByRole('button', { name: '重试' })
    fireEvent.click(retry)
    await waitFor(() => expect(screen.getByText('DASHBOARD_HOME')).toBeInTheDocument())
  })

  it('renders the dashboard when onboarding is already complete', async () => {
    mocks.getMyProfile.mockResolvedValue({ onboarding: { completed_at: '2026-01-01T00:00:00Z' } })
    renderAt('/')
    expect(await screen.findByText('DASHBOARD_HOME')).toBeInTheDocument()
  })
})
