import { useEffect, useState } from 'react'
import { useNavigate, useLocation, Outlet } from 'react-router-dom'
import { getWeeks, getInbody, triggerSync, formatWeekRange, type WeekSummary } from '../api'
import { useUser } from '../UserContextValue'
import TopNav from './TopNav'
import NotificationPopup from './NotificationPopup'

export default function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useUser()
  const [mobileOpen, setMobileOpen] = useState(false)

  const [weeks, setWeeks] = useState<WeekSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [hasInbody, setHasInbody] = useState(false)

  // Extract current folder from URL
  const folderMatch = location.pathname.match(/\/week\/(.+)/)
  const currentFolder = folderMatch ? folderMatch[1] : null

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  const handleSync = () => {
    setSyncing(true)
    setSyncMsg(null)
    triggerSync(user)
      .then((res) => {
        setSyncMsg(res.success ? '同步完成' : `同步失败: ${res.error}`)
        if (res.success) {
          getWeeks(user).then((data) => setWeeks(data.weeks))
        }
      })
      .catch(() => setSyncMsg('同步请求失败'))
      .finally(() => {
        setSyncing(false)
        setTimeout(() => setSyncMsg(null), 4000)
      })
  }

  useEffect(() => {
    if (!user) return
    setLoading(true)
    getWeeks(user)
      .then((data) => setWeeks(data.weeks))
      .finally(() => setLoading(false))
    // Probe InBody scans so we can hide the tab for users without any
    getInbody(user)
      .then((data) => setHasInbody(data.scans.length > 0))
      .catch(() => setHasInbody(false))
  }, [user])

  const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path + '/')

  return (
    <div className="min-h-screen flex">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 sm:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <nav className={`w-[260px] h-screen bg-bg-secondary border-r border-border flex flex-col fixed left-0 top-0 z-40 transition-transform duration-300 ease-in-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} sm:translate-x-0`}>
        <div className="px-5 pt-6 pb-5 flex-shrink-0">
          <div className="flex items-center justify-between">
            <button onClick={() => navigate('/')} className="flex items-center gap-2.5 cursor-pointer">
              <div className="w-8 h-8 rounded-lg bg-accent-green/15 flex items-center justify-center">
                <span className="text-accent-green text-sm font-bold font-mono">S</span>
              </div>
              <div>
                <h1 className="text-base font-bold tracking-tight text-text-primary leading-none">STRIDE</h1>
                <p className="text-xs font-mono text-text-muted tracking-widest mt-0.5">训练中心</p>
              </div>
            </button>
            {/* Close button — mobile only */}
            <button
              className="sm:hidden p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-card transition-colors"
              onClick={() => setMobileOpen(false)}
              aria-label="关闭菜单"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-5 pb-2 flex-shrink-0">
          <p className="text-xs font-mono text-text-muted tracking-wider">训练周</p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-1.5">
              {weeks.map((week, i) => {
                const isWeekActive = currentFolder === week.folder
                return (
                  <button
                    key={week.folder}
                    onClick={() => navigate(`/week/${week.folder}`)}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-all duration-200 animate-fade-in opacity-0 ${
                      isWeekActive
                        ? 'bg-accent-green/8 border-accent-green/30'
                        : 'bg-bg-card border-border-subtle hover:bg-bg-card-hover hover:border-border'
                    }`}
                    style={{ animationDelay: `${i * 40}ms`, animationFillMode: 'forwards' }}
                  >
                    <p className={`text-sm font-semibold ${isWeekActive ? 'text-accent-green' : 'text-text-primary'}`}>
                      {formatWeekRange(week.date_from, week.date_to)}
                    </p>
                    {week.plan_title && (
                      <p className="text-xs text-text-secondary mt-1 truncate leading-snug">
                        {week.plan_title}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      <span className="text-xs font-mono text-text-muted">
                        {week.activity_count} 次训练
                      </span>
                      <span className="text-xs font-mono text-accent-green">
                        {week.total_km} km
                      </span>
                      {week.has_feedback && (
                        <span className="text-[11px] font-mono text-accent-cyan bg-accent-cyan/10 px-1 py-0.5 rounded">
                          反馈
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="px-3 py-3 border-t border-border-subtle space-y-2 flex-shrink-0">
          <button
            onClick={() => navigate('/plan')}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
              isActive('/plan')
                ? 'border-accent-purple/50 text-accent-purple bg-accent-purple/10'
                : 'border-accent-purple/30 text-accent-purple hover:bg-accent-purple/10'
            }`}
          >
            2026夏训总纲
          </button>
          <button
            onClick={() => navigate('/health')}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
              isActive('/health')
                ? 'border-accent-cyan/50 text-accent-cyan bg-accent-cyan/10'
                : 'border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10'
            }`}
          >
            身体指标
          </button>
          <button
            onClick={() => navigate('/ability')}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
              isActive('/ability')
                ? 'border-accent-green/50 text-accent-green bg-accent-green/10'
                : 'border-accent-green/30 text-accent-green hover:bg-accent-green/10'
            }`}
          >
            成绩预测
          </button>
          <button
            onClick={() => navigate('/teams')}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
              isActive('/teams')
                ? 'border-accent-red/50 text-accent-red bg-accent-red/10'
                : 'border-accent-red/30 text-accent-red hover:bg-accent-red/10'
            }`}
          >
            团队
          </button>
          {hasInbody && (
            <button
              onClick={() => navigate('/inbody')}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
                isActive('/inbody')
                  ? 'border-accent-amber/50 text-accent-amber bg-accent-amber/10'
                  : 'border-accent-amber/30 text-accent-amber hover:bg-accent-amber/10'
              }`}
            >
              体测记录
            </button>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border border-accent-green/30 text-accent-green hover:bg-accent-green/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {syncing ? (
              <>
                <span className="w-3 h-3 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
                同步中...
              </>
            ) : (
              '同步手表数据'
            )}
          </button>
          {syncMsg && (
            <p className={`text-xs font-mono text-center ${syncMsg.includes('失败') ? 'text-accent-red' : 'text-accent-green'}`}>
              {syncMsg}
            </p>
          )}
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 ml-0 sm:ml-[260px] min-w-0">
        <TopNav onOpenMobileSidebar={() => setMobileOpen(true)} />
        <Outlet />
      </main>

      <NotificationPopup />
    </div>
  )
}
