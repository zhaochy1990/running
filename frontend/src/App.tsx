import { BrowserRouter, Routes, Route } from 'react-router-dom'
import WeekLayout from './pages/WeekLayout'
import ActivityDetailPage from './pages/ActivityDetailPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<WeekLayout />} />
        <Route path="/week/:folder" element={<WeekLayout />} />
        <Route path="/activity/:id" element={<ActivityDetailPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
