import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { trackPageView } from './appInsights'
import { routeNameFor } from './routeNames'

// Must be a direct child of <BrowserRouter> in App.tsx, NOT inside <AppLayout>.
// AppLayout sits behind nested <Routes> + ProtectedRoute + OnboardingGate, so
// placing this there would miss /login, /register, and /onboarding entirely.
export default function RouteTracker(): null {
  const { pathname } = useLocation()
  const hydrated = useAuthStore((s) => s.hydrated)

  useEffect(() => {
    if (!hydrated) return
    void trackPageView(routeNameFor(pathname), pathname)
  }, [pathname, hydrated])

  return null
}
