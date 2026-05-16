import { useLocation } from 'react-router-dom'
import { resolveBreadcrumb, type BreadcrumbCtx } from '../lib/breadcrumb'

interface BreadcrumbProps {
  current?: string
}

export default function Breadcrumb({ current }: BreadcrumbProps) {
  const location = useLocation()
  const ctx: BreadcrumbCtx | undefined = current ? { current } : undefined
  const crumb = resolveBreadcrumb(location.pathname, ctx)
  return (
    <nav
      aria-label="breadcrumb"
      data-testid="breadcrumb"
      className="hidden sm:flex items-center gap-1.5 font-mono text-[12px] text-text-muted"
    >
      <span className="text-text-secondary font-medium">{crumb.section}</span>
      {crumb.current && (
        <>
          <span className="opacity-50">/</span>
          <span className="text-text-primary font-semibold">{crumb.current}</span>
        </>
      )}
    </nav>
  )
}
