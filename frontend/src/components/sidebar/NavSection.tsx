import { type ReactNode } from 'react'

interface NavSectionProps {
  label: string
  children: ReactNode
  collapsed?: boolean
}

export default function NavSection({ label, children, collapsed }: NavSectionProps) {
  return (
    <div className="flex flex-col gap-px mb-3.5">
      <p
        className={`font-mono text-[9px] text-text-muted tracking-[0.16em] uppercase font-semibold px-3 pt-1.5 pb-2 ${
          collapsed ? 'invisible h-2 py-0' : ''
        }`}
      >
        {label}
      </p>
      {children}
    </div>
  )
}
