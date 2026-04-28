type RouteRule = readonly [RegExp | string, string]

const RULES: readonly RouteRule[] = [
  ['/', 'Home'],
  [/^\/week\/[^/]+$/, 'Week View'],
  [/^\/activity\/[^/]+$/, 'Activity Detail'],
  ['/health', 'Health'],
  ['/inbody', 'InBody'],
  ['/plan', 'Training Plan'],
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
