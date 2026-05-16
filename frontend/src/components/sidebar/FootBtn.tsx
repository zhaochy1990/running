import { type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

interface FootBtnProps {
  icon: ReactNode
  label?: string
  to?: string
  onClick?: () => void
  title?: string
  collapsed?: boolean
}

export default function FootBtn({ icon, label, to, onClick, title, collapsed }: FootBtnProps) {
  const navigate = useNavigate()
  const handle = () => {
    if (to) navigate(to)
    else onClick?.()
  }
  return (
    <button
      type="button"
      onClick={handle}
      title={title ?? label}
      className="flex-1 h-[30px] flex items-center justify-center gap-1.5 border border-border-subtle bg-bg-card text-text-muted hover:text-text-primary hover:border-border rounded-lg transition-colors cursor-pointer"
    >
      <span className="grid place-items-center">{icon}</span>
      {!collapsed && label && <span className="text-[11px]">{label}</span>}
    </button>
  )
}
