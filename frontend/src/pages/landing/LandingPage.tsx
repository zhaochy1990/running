import { useState } from 'react'
import './landing.css'
import LandingNav from './LandingNav'
import Hero from './sections/Hero'
import ReversePlan from './sections/ReversePlan'
import Pillars from './sections/Pillars'
import Features from './sections/Features'
import DataShowcase from './sections/DataShowcase'
import Closer from './sections/Closer'
import LandingFooter from './sections/LandingFooter'

export default function LandingPage({ initialLoginOpen = false }: { initialLoginOpen?: boolean }) {
  const [loginOpen, setLoginOpen] = useState(initialLoginOpen)
  const openLogin = () => setLoginOpen(true)

  return (
    <div className="landing-root">
      <LandingNav onLogin={openLogin} />
      <Hero onLogin={openLogin} />

      {/* strip — sync source badges */}
      <div className="strip">
        <div className="strip-in wrap">
          <span className="lab">同步自</span>
          <b>Garmin</b><b>COROS</b>
        </div>
      </div>

      <ReversePlan />
      <Pillars />
      <Features />
      <DataShowcase />
      <Closer onLogin={openLogin} />
      <LandingFooter onLogin={openLogin} />

      {/* LoginModal 在 Task 4 接入：{loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />} */}
      {/* loginOpen state is managed here; Task 4 will mount LoginModal here */}
      {loginOpen && null}
    </div>
  )
}
