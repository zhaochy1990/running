import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuthStore } from './store/authStore'
import { UserProvider } from './UserContext'
import AppLayout from './components/AppLayout'
import WeekLayout from './pages/WeekLayout'
import ActivityDetailPage from './pages/ActivityDetailPage'
import HealthPage from './pages/HealthPage'
import BodyCompositionPage from './pages/BodyCompositionPage'
import TrainingPlanPage from './pages/TrainingPlanPage'
import TrainingPlanAdjustPage from './pages/TrainingPlanAdjustPage'
import ActivitiesPage from './pages/ActivitiesPage'
import AbilityPage from './pages/AbilityPage'
import TrainingStatusPage from './pages/TrainingStatusPage'
import RegisterPage from './pages/RegisterPage'
import OnboardingWizard from './pages/OnboardingWizard'
import TeamsListPage from './pages/teams/TeamsListPage'
import TeamDetailPage from './pages/teams/TeamDetailPage'
import CreateTeamPage from './pages/teams/CreateTeamPage'
import UserCenterPage from './pages/UserCenterPage'
import { getMyProfile } from './api'
import LandingPage from './pages/landing/LandingPage'

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
      .then((p) => setGateState(p.onboarding.completed_at ? 'ready' : 'onboarding'))
      .catch(() => setGateState('onboarding'))
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

function Dashboard() {
  return (
    <OnboardingGate>
      <UserProvider>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<WeekLayout />} />
            <Route path="/week/:folder" element={<WeekLayout />} />
            <Route path="/activity/:id" element={<ActivityDetailPage />} />
            <Route path="/teams/:teamId/activity/:userId/:labelId" element={<ActivityDetailPage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/body-composition" element={<BodyCompositionPage />} />
            <Route path="/plan" element={<TrainingPlanPage />} />
            <Route path="/plan/adjust" element={<TrainingPlanAdjustPage />} />
            <Route path="/activities" element={<ActivitiesPage />} />
            <Route path="/ability" element={<AbilityPage />} />
            <Route path="/training-status" element={<TrainingStatusPage />} />
            <Route path="/teams" element={<TeamsListPage />} />
            <Route path="/teams/new" element={<CreateTeamPage />} />
            <Route path="/teams/:id" element={<TeamDetailPage />} />
            <Route path="/settings" element={<UserCenterPage />} />
            <Route path="/profile" element={<Navigate to="/settings" replace />} />
            <Route path="/watch" element={<Navigate to="/settings?tab=watch" replace />} />
          </Route>
        </Routes>
      </UserProvider>
    </OnboardingGate>
  )
}

function AppOrLanding() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }
  return <Dashboard />
}

function LoginEntry() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (isAuthenticated) return <Navigate to="/" replace />
  return <LandingPage initialLoginOpen />
}

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginEntry />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/onboarding" element={
        <ProtectedRoute><OnboardingWizard /></ProtectedRoute>
      } />
      <Route path="/*" element={<AppOrLanding />} />
    </Routes>
  )
}
