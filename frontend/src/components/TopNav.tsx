import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useUser } from '../UserContextValue'
import MessageCenter from './MessageCenter'

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
      className="sticky top-0 z-30 flex items-center h-14 px-3 sm:px-5 bg-bg-secondary border-b border-border"
    >
      {/* Mobile hamburger */}
      <button
        onClick={onOpenMobileSidebar}
        className="sm:hidden p-1.5 -ml-1 mr-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-card transition-colors"
        aria-label="打开菜单"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Mobile-only branding (desktop branding lives in the sidebar) */}
      <span className="sm:hidden text-sm font-bold text-text-primary tracking-tight">STRIDE</span>

      {/* Spacer pushes the right cluster to the edge */}
      <div className="flex-1" />

      {/* Right cluster: message center → profile → logout */}
      <div className="flex items-center gap-2">
        <MessageCenter />

        <button
          type="button"
          onClick={() => navigate('/profile')}
          title="编辑个人资料"
          data-testid="profile-button"
          className="flex items-center gap-2 h-9 px-3 rounded-lg border border-border-subtle bg-bg-card hover:bg-bg-card-hover transition-colors cursor-pointer"
        >
          <span
            className="w-6 h-6 rounded-full bg-accent-green/15 text-accent-green flex items-center justify-center text-xs font-bold font-mono"
            aria-hidden="true"
          >
            {(displayName || '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="text-xs font-mono text-text-secondary truncate max-w-[120px]">
            {displayName}
          </span>
        </button>

        <button
          type="button"
          onClick={handleLogout}
          disabled={signingOut}
          data-testid="logout-button"
          className="h-9 px-3 rounded-lg border border-border text-xs font-medium text-text-muted hover:bg-bg-card hover:text-text-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          {signingOut ? '登出中...' : '登出'}
        </button>
      </div>
    </header>
  )
}
