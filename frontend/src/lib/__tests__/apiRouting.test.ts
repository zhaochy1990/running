import { afterEach, describe, expect, it } from 'vitest'

import { apiUrl } from '../apiRouting'

const TENCENT = 'https://124.221.38.59'

function setRouting(cfg: unknown): void {
  ;(window as unknown as { __STRIDE_ROUTING__?: unknown }).__STRIDE_ROUTING__ = cfg
}

afterEach(() => {
  delete (window as unknown as { __STRIDE_ROUTING__?: unknown }).__STRIDE_ROUTING__
})

describe('apiUrl (client-side Tencent/Azure routing, ADR 0017 interim)', () => {
  it('stays relative when nothing is injected (same-origin via BFF)', () => {
    expect(apiUrl('GET', '/api/users/me/profile')).toBe('/api/users/me/profile')
    expect(apiUrl('POST', '/api/auth/login')).toBe('/api/auth/login')
  })

  it('stays relative when directBaseUrl is empty', () => {
    setRouting({ directBaseUrl: '' })
    expect(apiUrl('GET', '/api/users/me/profile')).toBe('/api/users/me/profile')
  })

  it('sends /api/auth/* direct to Tencent when configured', () => {
    setRouting({ directBaseUrl: TENCENT, authPrefix: '/api/auth', routes: [] })
    expect(apiUrl('POST', '/api/auth/login')).toBe(`${TENCENT}/api/auth/login`)
  })

  it('sends a Go-routed endpoint direct, keeps Python relative', () => {
    setRouting({
      directBaseUrl: TENCENT,
      authPrefix: '/api/auth',
      routes: [
        { method: 'GET', path: '/api/:user/activities', upstream: 'go' },
        { method: 'GET', path: '/api/:user/weeks', upstream: 'python' },
      ],
    })
    expect(apiUrl('GET', '/api/abc/activities')).toBe(`${TENCENT}/api/abc/activities`)
    expect(apiUrl('GET', '/api/abc/weeks')).toBe('/api/abc/weeks')
  })

  it('matches routes by pathname while preserving the query string', () => {
    setRouting({
      directBaseUrl: TENCENT,
      routes: [{ method: 'GET', path: '/api/:user/activities', upstream: 'go' }],
    })
    const path = '/api/abc/activities?date_from=2026-08-01&limit=200'
    expect(apiUrl('GET', path)).toBe(`${TENCENT}${path}`)
  })

  it('honors most-specific-wins: a more-specific Python route shadows a Go pattern', () => {
    setRouting({
      directBaseUrl: TENCENT,
      authPrefix: '/api/auth',
      routes: [
        { method: 'GET', path: '/api/users/me/master-plan/:planId', upstream: 'go' },
        { method: 'GET', path: '/api/users/me/master-plan/draft', upstream: 'python' },
      ],
    })
    // :planId (go) matches, but draft (python, more literal) wins → relative.
    expect(apiUrl('GET', '/api/users/me/master-plan/draft')).toBe('/api/users/me/master-plan/draft')
    // a real id only matches the go pattern → direct.
    expect(apiUrl('GET', '/api/users/me/master-plan/123')).toBe(`${TENCENT}/api/users/me/master-plan/123`)
  })

  it('is method-aware', () => {
    setRouting({
      directBaseUrl: TENCENT,
      authPrefix: '/api/auth',
      routes: [
        { method: 'GET', path: '/api/users/me/profile', upstream: 'go' },
        { method: 'POST', path: '/api/users/me/profile', upstream: 'python' },
      ],
    })
    expect(apiUrl('GET', '/api/users/me/profile')).toBe(`${TENCENT}/api/users/me/profile`)
    expect(apiUrl('POST', '/api/users/me/profile')).toBe('/api/users/me/profile')
  })
})
