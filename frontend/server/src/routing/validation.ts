import {
  hasGoRoutes,
  hasPartialPlanSetupGoCutover,
  hasPartialWebOnboardingGoCutover,
  unsupportedGoRoutes,
} from './table.js'

/** Validate fail-closed route configuration at BFF startup. */
export function validateRouteConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  goApiUrl = env.GO_API_URL?.trim() || null,
): void {
  if (hasGoRoutes(env) && !goApiUrl) {
    throw new Error('stride-web BFF: an API route is set to Go but GO_API_URL is not set')
  }
  const unsupportedRoutes = unsupportedGoRoutes(env)
  if (unsupportedRoutes.length > 0) {
    throw new Error(
      `stride-web BFF: routes not implemented by Go are set to Go: ${unsupportedRoutes
        .map((route) => route.env)
        .join(', ')}`,
    )
  }

  if (hasPartialPlanSetupGoCutover(env)) {
    throw new Error('stride-web BFF: plan-setup Go routes must be enabled as an atomic set')
  }
  if (hasPartialWebOnboardingGoCutover(env)) {
    throw new Error('stride-web BFF: Web onboarding Go routes must be enabled as an atomic set')
  }
}
