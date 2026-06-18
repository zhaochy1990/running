import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import LandingPage from '../LandingPage'

vi.mock('../../../store/authStore', () => ({
  useAuthStore: () => ({ isAuthenticated: false, login: vi.fn() }),
}))

// jsdom does not implement IntersectionObserver — provide a minimal stub
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      constructor(public cb: IntersectionObserverCallback) {}
    } as unknown as typeof IntersectionObserver,
  )
})

function renderLanding(initialLoginOpen = false) {
  return render(
    <MemoryRouter>
      <LandingPage initialLoginOpen={initialLoginOpen} />
    </MemoryRouter>,
  )
}

describe('LandingPage', () => {
  it('renders the hero headline and key sections', () => {
    renderLanding()
    expect(screen.getByRole('heading', { name: /每一步都有数据/ })).toBeInTheDocument()
    expect(screen.getByText('从比赛日倒推,精准规划每一步')).toBeInTheDocument()
    expect(screen.getByText('跑得快,是练出来的整体结果')).toBeInTheDocument()
    expect(screen.getByText('你的训练,一屏看懂')).toBeInTheDocument()
  })

  it('does not open the login modal by default', () => {
    renderLanding(false)
    expect(screen.queryByRole('dialog', { name: /登录 STRIDE/ })).not.toBeInTheDocument()
  })

  it('renders the login modal when initialLoginOpen is true', () => {
    renderLanding(true)
    expect(screen.getByRole('dialog', { name: /登录 STRIDE/ })).toBeInTheDocument()
  })

  it('opens the login modal when a nav login trigger is clicked', () => {
    renderLanding(false)
    // LandingNav and Hero both get onLogin; find a button that triggers it
    const loginButtons = screen.getAllByRole('button', { name: /开始训练|登录/i })
    expect(loginButtons.length).toBeGreaterThan(0)
    fireEvent.click(loginButtons[0])
    expect(screen.getByRole('dialog', { name: /登录 STRIDE/ })).toBeInTheDocument()
  })
})
