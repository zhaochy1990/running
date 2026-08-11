import {
  hasGoRoutes,
  hasPartialPlanSetupGoCutover,
  hasPartialWeeklyFeedbackGoCutover,
  WEEKLY_FEEDBACK_GO_ROUTE_ENVS,
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
  if (hasPartialWeeklyFeedbackGoCutover(env)) {
    throw new Error('stride-web BFF: weekly-feedback PUT requires both week readers on Go')
  }
  if (env.STRIDE_WEEKLY_FEEDBACK_CUTOVER_COMPLETE?.trim().toLowerCase() === 'true'
      && WEEKLY_FEEDBACK_GO_ROUTE_ENVS.some((name) => env[name]?.trim().toLowerCase() !== 'go')) {
    throw new Error('stride-web BFF: completed weekly-feedback cutover cannot route any member back to Python')
  }
}
