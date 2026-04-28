// Application Insights bootstrap.
//
// The SDK is loaded via dynamic import() so that bundles built without
// VITE_APPLICATIONINSIGHTS_CONNECTION_STRING never include the ~80 KB
// applicationinsights-web chunk in the initial payload (Vite code-splits
// the dynamic import into a separate chunk that is fetched only when this
// module's getAppInsights() is called and the env var is set).
//
// Public surface (all async, all no-op when telemetry is disabled):
//   getAppInsights() -> Promise<AI | null>
//   trackPageView(name, uri)
//   setAuthUser(userId)
//   clearAuthUser()

interface AI {
  trackPageView(properties: { name: string; uri: string }): void
  setAuthenticatedUserContext(
    authenticatedUserId: string,
    accountId?: string,
    storeInCookie?: boolean,
  ): void
  clearAuthenticatedUserContext(): void
}

let cached: Promise<AI | null> | null = null
let warned = false

export function getAppInsights(): Promise<AI | null> {
  if (cached) return cached

  const connectionString = import.meta.env.VITE_APPLICATIONINSIGHTS_CONNECTION_STRING
  if (!connectionString) {
    if (!warned) {
      console.info('Application Insights disabled (no connection string)')
      warned = true
    }
    cached = Promise.resolve(null)
    return cached
  }

  cached = import('@microsoft/applicationinsights-web').then(({ ApplicationInsights }) => {
    // Page-level only: we drive trackPageView ourselves for stable route names,
    // skip auto AJAX/fetch tracking (requests carry Authorization: Bearer), and
    // skip exception/promise-rejection capture (out of scope for v1).
    const ai = new ApplicationInsights({
      config: {
        connectionString,
        enableAutoRouteTracking: false,
        disableFetchTracking: true,
        disableAjaxTracking: true,
        disableExceptionTracking: true,
        enableUnhandledPromiseRejectionTracking: false,
      },
    })
    ai.loadAppInsights()
    return ai as unknown as AI
  })
  return cached
}

export async function trackPageView(name: string, uri: string): Promise<void> {
  const ai = await getAppInsights()
  ai?.trackPageView({ name, uri })
}

export async function setAuthUser(userId: string): Promise<void> {
  const ai = await getAppInsights()
  ai?.setAuthenticatedUserContext(userId, undefined, true)
}

export async function clearAuthUser(): Promise<void> {
  const ai = await getAppInsights()
  ai?.clearAuthenticatedUserContext()
}
