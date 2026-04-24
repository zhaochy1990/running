import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

function App() {
  const hydrate = useAuthStore((s) => s.hydrate)

  useEffect(() => {
    hydrate()
  }, [hydrate])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={
          <ProtectedRoute>
            <UserProvider>
              <Routes>
                <Route element={<AppLayout />}>
                  <Route path="/" element={<WeekLayout />} />
                  <Route path="/week/:folder" element={<WeekLayout />} />
                  <Route path="/activity/:id" element={<ActivityDetailPage />} />
                  <Route path="/health" element={<HealthPage />} />
                  <Route path="/inbody" element={<InbodyPage />} />
                  <Route path="/plan" element={<TrainingPlanPage />} />
                  <Route path="/ability" element={<AbilityPage />} />
                </Route>
              </Routes>
            </UserProvider>
          </ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  )
}

export default App
