import { describe, it, expect } from 'vitest'
import { routeNameFor } from '../routeNames'

describe('routeNameFor', () => {
  it('maps the home route', () => {
    expect(routeNameFor('/')).toBe('Home')
  })

  it.each([
    ['/health', 'Health'],
    ['/inbody', 'InBody'],
    ['/plan', 'Training Plan'],
    ['/ability', 'Ability'],
    ['/status', 'Status'],
    ['/login', 'Login'],
    ['/register', 'Register'],
    ['/onboarding', 'Onboarding'],
  ])('maps %s to %s', (path, expected) => {
    expect(routeNameFor(path)).toBe(expected)
  })

  it('collapses /week/:folder regardless of folder value', () => {
    expect(routeNameFor('/week/2026-04-27_05-03(P1W2)')).toBe('Week View')
    expect(routeNameFor('/week/2026-04-20_04-26(W0)')).toBe('Week View')
  })

  it('collapses /activity/:id regardless of id value', () => {
    expect(routeNameFor('/activity/abc123')).toBe('Activity Detail')
    expect(routeNameFor('/activity/xyz789')).toBe('Activity Detail')
  })

  it('falls through to raw pathname for unknown routes', () => {
    expect(routeNameFor('/something/else')).toBe('/something/else')
    expect(routeNameFor('/admin')).toBe('/admin')
  })

  it('does not collapse nested unknown sub-routes under known prefixes', () => {
    // /week/foo/bar is not /week/:folder; should fall through
    expect(routeNameFor('/week/foo/bar')).toBe('/week/foo/bar')
  })
})
