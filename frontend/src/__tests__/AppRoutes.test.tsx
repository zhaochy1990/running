import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const mocks = vi.hoisted(() => ({ isAuthenticated: false }))
vi.mock('../store/authStore', () => ({
  useAuthStore: (sel?: (s: { isAuthenticated: boolean; hydrate: () => void }) => unknown) => {
    const state = { isAuthenticated: mocks.isAuthenticated, hydrate: () => {} }
    return sel ? sel(state) : state
  },
}))
// 把已登录子树替换成占位,避免拉起真实 dashboard / api
vi.mock('../pages/WeekLayout', () => ({ default: () => <div>DASHBOARD_HOME</div> }))
vi.mock('../App', async (orig) => orig()) // 防循环;AppRoutes 独立文件无需

// jsdom does not implement IntersectionObserver — provide a minimal stub
beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      cb: IntersectionObserverCallback
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
      constructor(cb: IntersectionObserverCallback) { this.cb = cb }
    } as unknown as typeof IntersectionObserver,
  )
})

import AppRoutes from '../AppRoutes'

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>)
}

describe('AppRoutes (unauthenticated)', () => {
  it('shows the landing page at /', () => {
    mocks.isAuthenticated = false
    renderAt('/')
    expect(screen.getByRole('heading', { name: /每一步都有数据/ })).toBeInTheDocument()
  })

  it('opens login modal at /login', () => {
    mocks.isAuthenticated = false
    renderAt('/login')
    expect(screen.getByRole('dialog', { name: /登录 STRIDE/ })).toBeInTheDocument()
  })

  it('redirects a protected deep link to /login (landing + modal)', () => {
    mocks.isAuthenticated = false
    renderAt('/activities')
    expect(screen.getByRole('dialog', { name: /登录 STRIDE/ })).toBeInTheDocument()
  })
})
