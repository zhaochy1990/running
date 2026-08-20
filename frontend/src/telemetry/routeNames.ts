type RouteRule = readonly [RegExp | string, string]

const RULES: readonly RouteRule[] = [
  ['/', 'Home'],
  [/^\/week\/[^/]+$/, 'Week View'],
  [/^\/activity\/[^/]+$/, 'Activity Detail'],
  [/^\/coach\/week\/[^/]+\/adjust$/, 'Coach Weekly Plan Adjust'],
  [/^\/coach\/master\/[^/]+\/adjust$/, 'Coach Master Plan Adjust'],
  ['/coach', 'Coach Chat'],
  ['/health', 'Health'],
  ['/body-composition', 'BodyComposition'],
  ['/plan/adjust', 'Training Plan Adjust'],
  ['/plan', 'Training Plan'],
  ['/activities', 'Activity List'],
  ['/ability', 'Ability'],
  ['/status', 'Status'],
  ['/login', 'Login'],
  ['/register', 'Register'],
  ['/onboarding', 'Onboarding'],
]

export function routeNameFor(pathname: string): string {
  for (const [rule, name] of RULES) {
    if (typeof rule === 'string' ? rule === pathname : rule.test(pathname)) {
      return name
    }
  }
  return pathname
}
