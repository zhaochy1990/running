export function fmtHMS(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return `${h}:${mm}:${ss}`
}

export function fmtGap(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds)) return '—'
  const sign = seconds > 0 ? '+' : seconds < 0 ? '−' : ''
  const abs = Math.abs(Math.round(seconds))
  const m = Math.floor(abs / 60)
  const s = abs % 60
  if (m === 0) return `${sign}${s}s`
  if (s === 0) return `${sign}${m}min`
  return `${sign}${m}min${String(s).padStart(2, '0')}s`
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

export function fmtScore(n: number | null | undefined, digits = 0): string {
  if (n == null || !isFinite(n)) return '—'
  return n.toFixed(digits)
}
