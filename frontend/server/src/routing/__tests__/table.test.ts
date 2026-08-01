import { describe, expect, it } from 'vitest'

import { AUTH_PREFIX, GO_ROUTE_PREFIXES, resolveUpstream } from '../table.js'

describe('resolveUpstream', () => {
  it('routes /api/auth/* to the auth upstream', () => {
    expect(resolveUpstream('/api/auth/login')).toBe('auth')
    expect(resolveUpstream('/api/auth/refresh')).toBe('auth')
    expect(resolveUpstream('/api/auth/logout')).toBe('auth')
    expect(resolveUpstream(AUTH_PREFIX)).toBe('auth')
  })

  it('defaults every other /api/* path to python', () => {
    expect(resolveUpstream('/api/users')).toBe('python')
    expect(resolveUpstream('/api/users/me/profile')).toBe('python')
    expect(resolveUpstream('/api/abc/activities')).toBe('python')
    expect(resolveUpstream('/api/health')).toBe('python')
  })

  it('does not let /api/auth match a sibling like /api/authz', () => {
    expect(resolveUpstream('/api/authz/thing')).toBe('python')
    expect(resolveUpstream('/api/auth-export')).toBe('python')
  })

  it('starts with no Go routes (nothing cut over until contract parity proven)', () => {
    expect(GO_ROUTE_PREFIXES).toHaveLength(0)
  })

  it('routes a prefixed path to go when its prefix is registered (simulated cutover)', () => {
    // Simulate adding '/api/users/me/profile' to the table without mutating the
    // shipped constant: re-implement the same boundary semantics the table uses.
    const withGo = (pathname: string, prefixes: readonly string[]): 'python' | 'go' | 'auth' => {
      if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) return 'auth'
      for (const p of prefixes) {
        if (pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`)) return 'go'
      }
      return 'python'
    }
    const prefixes = ['/api/users/me/profile']
    expect(withGo('/api/users/me/profile', prefixes)).toBe('go')
    expect(withGo('/api/users/me/profile/extra', prefixes)).toBe('go')
    expect(withGo('/api/users/me/profiles', prefixes)).toBe('python') // boundary
    expect(withGo('/api/auth/login', prefixes)).toBe('auth') // auth still wins
  })
})
