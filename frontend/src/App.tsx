import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { UserProvider } from './UserContext'
import WeekLayout from './pages/WeekLayout'
import ActivityDetailPage from './pages/ActivityDetailPage'
import HealthPage from './pages/HealthPage'
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
                <Route path="/" element={<WeekLayout />} />
                <Route path="/week/:folder" element={<WeekLayout />} />
                <Route path="/activity/:id" element={<ActivityDetailPage />} />
                <Route path="/health" element={<HealthPage />} />
              </Routes>
            </UserProvider>
          </ProtectedRoute>
        } />
      </Routes>
    </BrowserRouter>
  )
}

export default App
