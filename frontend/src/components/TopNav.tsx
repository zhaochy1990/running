import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useUser } from '../UserContextValue'
import MessageCenter from './MessageCenter'
import Breadcrumb from './Breadcrumb'
import SyncStatusPill from './SyncStatusPill'

interface TopNavProps {
  onOpenMobileSidebar: () => void
}

export default function TopNav({ onOpenMobileSidebar }: TopNavProps) {
  const navigate = useNavigate()
  const { displayName } = useUser()
  const logout = useAuthStore((s) => s.logout)
  const [signingOut, setSigningOut] = useState(false)

  const handleLogout = async () => {
    setSigningOut(true)
    try {
      await logout()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  return (
    <header
      data-testid="top-nav"
      className="sticky top-0 z-30 flex items-center gap-3 h-[var(--topbar-h)] px-3.5 bg-bg-card border-b border-border-subtle"
    >
      <button
        onClick={onOpenMobileSidebar}
        className="sm:hidden p-1.5 -ml-1 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors"
        aria-label="打开菜单"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      <button
        onClick={() => navigate('/')}
        className="hidden sm:flex items-center gap-2 cursor-pointer"
        style={{ width: 206 }}
      >
        <span
          className="w-[26px] h-[26px] rounded-md bg-accent-green/15 text-accent-green flex items-center justify-center font-mono font-bold text-sm"
          aria-hidden="true"
        >
          S
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-[13px] font-bold leading-tight text-text-primary">STRIDE</span>
          <span className="font-mono text-[9px] text-text-muted tracking-[0.16em]">训练中心</span>
        </span>
      </button>

      <span className="hidden sm:block w-px h-[22px] bg-border-subtle" aria-hidden />

      <Breadcrumb />

      <div className="flex-1" />

      <SyncStatusPill />

      <MessageCenter />

      <button
        type="button"
        onClick={() => navigate('/settings')}
        title="用户中心"
        data-testid="profile-button"
        className="flex items-center gap-2 h-[30px] px-2.5 rounded-full border border-border-subtle bg-bg-card hover:border-border transition-colors cursor-pointer"
      >
        <span
          className="w-[22px] h-[22px] rounded-full bg-accent-green/15 text-accent-green flex items-center justify-center text-[11px] font-bold font-mono"
          aria-hidden="true"
        >
          {(displayName || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden sm:inline text-xs font-mono text-text-secondary truncate max-w-[120px]">
          {displayName}
        </span>
        <span className="text-text-muted text-[10px]" aria-hidden>▾</span>
      </button>

      <button
        type="button"
        onClick={handleLogout}
        disabled={signingOut}
        data-testid="logout-button"
        className="h-[30px] px-3 rounded-md border border-border-subtle text-xs font-medium text-text-muted hover:bg-bg-card-hover hover:text-text-secondary hover:border-border disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
      >
        {signingOut ? '登出中...' : '登出'}
      </button>
    </header>
  )
}
