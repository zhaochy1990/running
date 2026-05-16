import { useEffect, useState } from 'react'
import { useLocation, useNavigate, Outlet } from 'react-router-dom'
import { getInbody } from '../api'
import { useUser } from '../UserContextValue'
import TopNav from './TopNav'
import NotificationPopup from './NotificationPopup'
import NavSection from './sidebar/NavSection'
import NavItem from './sidebar/NavItem'
import SidebarFoot from './sidebar/SidebarFoot'
import RaceCard from './sidebar/RaceCard'
import FootRow from './sidebar/FootRow'
import FootBtn from './sidebar/FootBtn'

const SIDEBAR_COLLAPSED_KEY = 'stride.sidebar.collapsed'

export default function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useUser()

  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [hasInbody, setHasInbody] = useState(false)

  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!user) return
    getInbody(user)
      .then((data) => setHasInbody(data.scans.length > 0))
      .catch(() => setHasInbody(false))
  }, [user])

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return (
    <div className="flex flex-col h-screen">
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 sm:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <TopNav onOpenMobileSidebar={() => setMobileOpen(true)} />

      <div className="flex flex-1 min-h-0">
        <nav
          className={`flex-shrink-0 bg-bg-card border-r border-border-subtle flex flex-col fixed sm:static left-0 top-0 h-full sm:h-auto z-40 transition-all duration-250 ease-out overflow-hidden
            ${mobileOpen ? 'translate-x-0' : '-translate-x-full sm:translate-x-0'}
            ${collapsed ? 'sm:w-[var(--sidebar-w-collapsed)]' : 'sm:w-[var(--sidebar-w)]'}
            w-[var(--sidebar-w)]
          `}
        >
          {/* Mobile-only brand header inside drawer */}
          <div className="sm:hidden px-4 pt-4 pb-3 flex items-center justify-between flex-shrink-0">
            <button
              onClick={() => navigate('/')}
              className="flex items-center gap-2.5 cursor-pointer"
            >
              <div className="w-8 h-8 rounded-lg bg-accent-green/15 flex items-center justify-center">
                <span className="text-accent-green text-sm font-bold font-mono">S</span>
              </div>
              <div className="text-left">
                <h1 className="text-base font-bold tracking-tight text-text-primary leading-none">
                  STRIDE
                </h1>
                <p className="text-[10px] font-mono text-text-muted tracking-widest mt-0.5">
                  训练中心
                </p>
              </div>
            </button>
            <button
              className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary transition-colors"
              onClick={() => setMobileOpen(false)}
              aria-label="关闭菜单"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="sidebar-nav flex-1 overflow-y-auto py-3 px-2.5 flex flex-col gap-px">
            <NavSection label="主功能" collapsed={collapsed}>
              <NavItem
                to="/"
                exact
                collapsed={collapsed}
                icon={<GridIcon />}
                text="本周训练"
              />
              <NavItem to="/plan" collapsed={collapsed} icon={<DocIcon />} text="训练计划" />
            </NavSection>

            <NavSection label="数据 / 分析" collapsed={collapsed}>
              <NavItem
                to="/ability"
                collapsed={collapsed}
                icon={<TargetIcon />}
                text="训练能力"
              />
              <NavItem
                to="/health"
                collapsed={collapsed}
                icon={<PulseIcon />}
                text="身体指标"
              />
              {hasInbody && (
                <NavItem
                  to="/inbody"
                  collapsed={collapsed}
                  icon={<UserIcon />}
                  text="体测记录"
                />
              )}
            </NavSection>

            <NavSection label="社群" collapsed={collapsed}>
              <NavItem to="/teams" collapsed={collapsed} icon={<UsersIcon />} text="团队" />
            </NavSection>
          </div>

          <SidebarFoot>
            <RaceCard collapsed={collapsed} />
            <FootRow collapsed={collapsed}>
              <FootBtn
                to="/settings"
                icon={<GearIcon />}
                label="设置"
                collapsed={collapsed}
              />
              <FootBtn
                onClick={toggleCollapsed}
                icon={<CollapseIcon collapsed={collapsed} />}
                title={collapsed ? '展开' : '折叠'}
                collapsed={collapsed}
              />
            </FootRow>
          </SidebarFoot>
        </nav>

        <main className="flex-1 min-w-0 overflow-y-auto bg-bg-primary">
          <Outlet />
        </main>
      </div>

      <NotificationPopup />
    </div>
  )
}

// ─── Inline icons (16×16 / 13×13 for foot) ──────────────────────────────────

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3l9 9-9 9-9-9z" opacity={0.5} />
    </svg>
  )
}

function PulseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  )
}

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 2a3 3 0 013 3v2a3 3 0 01-6 0V5a3 3 0 013-3z" />
      <path d="M19 21v-2a4 4 0 00-4-4H9a4 4 0 00-4 4v2" />
      <circle cx="12" cy="11" r="1" />
    </svg>
  )
}

function UsersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  )
}

function CollapseIcon({ collapsed }: { collapsed?: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      style={{ transform: collapsed ? 'rotate(180deg)' : 'none' }}
    >
      <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
    </svg>
  )
}
