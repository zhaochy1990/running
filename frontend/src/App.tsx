import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { UserProvider } from './UserContext'
import WeekLayout from './pages/WeekLayout'
import ActivityDetailPage from './pages/ActivityDetailPage'
import HealthPage from './pages/HealthPage'

function App() {
  return (
    <BrowserRouter>
      <UserProvider>
        <Routes>
          <Route path="/" element={<WeekLayout />} />
          <Route path="/week/:folder" element={<WeekLayout />} />
          <Route path="/activity/:id" element={<ActivityDetailPage />} />
          <Route path="/health" element={<HealthPage />} />
        </Routes>
      </UserProvider>
    </BrowserRouter>
  )
}

export default App
