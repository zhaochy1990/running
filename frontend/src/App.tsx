import { useEffect } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import RouteTracker from './telemetry/RouteTracker'
import AppRoutes from './AppRoutes'

function App() {
  const hydrate = useAuthStore((s) => s.hydrate)
  useEffect(() => { hydrate() }, [hydrate])
  return (
    <BrowserRouter>
      <RouteTracker />
      <AppRoutes />
    </BrowserRouter>
  )
}
export default App
