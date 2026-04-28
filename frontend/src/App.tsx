import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { UserProvider } from './UserContext'
import AppLayout from './components/AppLayout'
import WeekLayout from './pages/WeekLayout'
import ActivityDetailPage from './pages/ActivityDetailPage'
import HealthPage from './pages/HealthPage'
import InbodyPage from './pages/InbodyPage'
import TrainingPlanPage from './pages/TrainingPlanPage'
import AbilityPage from './pages/AbilityPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import OnboardingWizard from './pages/OnboardingWizard'
import TeamsListPage from './pages/teams/TeamsListPage'
import TeamDetailPage from './pages/teams/TeamDetailPage'
import CreateTeamPage from './pages/teams/CreateTeamPage'
import { getMyProfile } from './api'
// RouteTracker MUST be a child of <BrowserRouter> at this top level —
// placing it inside <AppLayout> would miss /login, /register, /onboarding.
import RouteTracker from './telemetry/RouteTracker'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

type GateState = 'loading' | 'onboarding' | 'ready'

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [gateState, setGateState] = useState<GateState>('loading')
  const location = useLocation()

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        setGateState(p.onboarding.completed_at ? 'ready' : 'onboarding')
      })
      .catch(() => {
        // No profile yet — must complete onboarding
        setGateState('onboarding')
      })
  }, [])

  if (gateState === 'loading') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  if (gateState === 'onboarding' && !location.pathname.startsWith('/onboarding')) {
    return <Navigate to="/onboarding" replace />
  }

  return <>{children}</>
}

function App() {
  const hydrate = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  return (
    <BrowserRouter>
      <RouteTracker />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/onboarding" element={
          <ProtectedRoute>
            <OnboardingWizard />
          </ProtectedRoute>
        } />
        <Route path="/*" element={
          <ProtectedRoute>
            <OnboardingGate>
              <UserProvider>
                <Routes>
                  <Route element={<AppLayout />}>
                    <Route path="/" element={<WeekLayout />} />
                    <Route path="/week/:folder" element={<WeekLayout />} />
                    <Route path="/activity/:id" element={<ActivityDetailPage />} />
                    <Route path="/teams/:teamId/activity/:userId/:labelId" element={<ActivityDetailPage />} />
                    <Route path="/health" element={<HealthPage />} />
                    <Route path="/inbody" element={<InbodyPage />} />
                    <Route path="/plan" element={<TrainingPlanPage />} />
                    <Route path="/ability" element={<AbilityPage />} />
                    <Route path="/teams" element={<TeamsListPage />} />
                    <Route path="/teams/new" element={<CreateTeamPage />} />
                    <Route path="/teams/:id" element={<TeamDetailPage />} />
                  </Route>
                </Routes>
              </UserProvider>
            </OnboardingGate>
          </ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  )
}

export default App
