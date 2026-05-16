import { type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

interface NavItemProps {
  to: string
  icon: ReactNode
  text: string
  tag?: string
  hasDot?: boolean
  exact?: boolean
  collapsed?: boolean
}

export default function NavItem({ to, icon, text, tag, hasDot, exact, collapsed }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={exact}
      title={collapsed ? text : undefined}
      className={({ isActive }) =>
        `relative flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${
          isActive
            ? 'bg-accent-green/10 border border-accent-green/30 text-accent-green-dim font-semibold'
            : 'border border-transparent text-text-secondary hover:bg-bg-secondary hover:text-text-primary'
        } ${collapsed ? 'justify-center px-0 py-2.5' : ''}`
      }
    >
      <span className="w-4 h-4 flex-shrink-0 grid place-items-center text-current">{icon}</span>
      {!collapsed && (
        <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis">{text}</span>
      )}
      {!collapsed && tag && (
        <span className="font-mono text-[9px] px-1.5 py-px rounded bg-bg-elevated text-text-muted tracking-wider flex-shrink-0">
          {tag}
        </span>
      )}
      {!collapsed && hasDot && (
        <span className="w-1.5 h-1.5 rounded-full bg-accent-red flex-shrink-0" />
      )}
    </NavLink>
  )
}
