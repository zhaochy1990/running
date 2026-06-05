export interface Breadcrumb {
  section: string
  current?: string
}

export interface BreadcrumbCtx {
  current?: string
}

export function resolveBreadcrumb(pathname: string, ctx?: BreadcrumbCtx): Breadcrumb {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return { section: 'STRIDE' }
  }

  if (pathname === '/') {
    return { section: '主功能', current: '本周训练' }
  }

  if (pathname.startsWith('/week/')) {
    return { section: '训练计划', current: ctx?.current ?? deriveWeekLabel(pathname.slice('/week/'.length)) }
  }

  if (pathname === '/plan') {
    return { section: '训练', current: '训练计划' }
  }

  if (pathname === '/activities') {
    return { section: '训练', current: '活动列表' }
  }

  if (pathname === '/ability') {
    return { section: '数据', current: '训练能力' }
  }

  if (pathname === '/health') {
    return { section: '数据', current: '身体指标' }
  }

  if (pathname === '/body-composition') {
    return { section: '数据', current: '体测记录' }
  }

  if (pathname === '/teams' || pathname.startsWith('/teams/')) {
    return { section: '社群', current: '团队' }
  }

  if (pathname === '/settings') {
    return { section: '设置' }
  }

  if (pathname.startsWith('/activity/')) {
    return { section: '本周训练', current: '训练记录 / 活动详情' }
  }

  if (pathname === '/onboarding') {
    return { section: '入门', current: '设置赛事目标' }
  }

  if (pathname === '/login' || pathname === '/register') {
    return { section: '账户' }
  }

  return { section: 'STRIDE' }
}

function deriveWeekLabel(folder: string): string {
  const decoded = (() => {
    try { return decodeURIComponent(folder) } catch { return folder }
  })()
  const phaseMatch = decoded.match(/\(([^)]+)\)/)
  const dateMatch = decoded.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/)
  const phase = phaseMatch?.[1]
  const dateLabel = dateMatch ? `${dateMatch[2]}-${dateMatch[3]} → ${dateMatch[4]}-${dateMatch[5]}` : null
  if (phase && dateLabel) return `${phase} · ${dateLabel}`
  return phase ?? dateLabel ?? decoded ?? 'W— · —'
}
