import type { ReactNode } from 'react'

export interface ViewHeadProps {
  eyebrow?: string
  title: string
  lede?: string
  actions?: ReactNode
  className?: string
}

export default function ViewHead({ eyebrow, title, lede, actions, className }: ViewHeadProps) {
  return (
    <div className={`mb-6 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 sm:gap-5 items-start sm:items-end ${className ?? ''}`}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="font-mono text-[10px] text-accent-green tracking-[0.14em] font-semibold uppercase mb-1.5">
            {eyebrow}
          </p>
        )}
        <h1 className="text-xl sm:text-2xl font-semibold tracking-[-0.015em] leading-[1.15] text-text-primary m-0">
          {title}
        </h1>
        {lede && (
          <p className="text-[13px] text-text-secondary mt-1.5 max-w-[520px]">
            {lede}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap gap-2 items-center">{actions}</div>}
    </div>
  )
}
