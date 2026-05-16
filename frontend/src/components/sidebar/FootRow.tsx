import { type ReactNode } from 'react'

interface FootRowProps {
  children: ReactNode
  collapsed?: boolean
}

export default function FootRow({ children, collapsed }: FootRowProps) {
  return <div className={`flex gap-1.5 ${collapsed ? 'flex-col' : ''}`}>{children}</div>
}
