import { useState, useEffect } from 'react'
import { triggerSync } from '../api'
import { useUser } from '../UserContextValue'

const LAST_SYNC_KEY = 'stride.last_sync_ts'

export default function SyncStatusPill() {
  const { user } = useUser()
  const [lastSync, setLastSync] = useState<number | null>(() => {
    const raw = localStorage.getItem(LAST_SYNC_KEY)
    return raw ? parseInt(raw, 10) : null
  })
  const [syncing, setSyncing] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  void tick

  const handleClick = async () => {
    if (syncing || !user) return
    setSyncing(true)
    try {
      const res = await triggerSync(user)
      if (res.success) {
        const ts = Date.now()
        localStorage.setItem(LAST_SYNC_KEY, String(ts))
        setLastSync(ts)
      }
    } finally {
      setSyncing(false)
    }
  }

  const label = syncing
    ? '同步中...'
    : lastSync
      ? `已同步 · ${relativeTime(Date.now() - lastSync)}`
      : '未同步'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={syncing}
      data-testid="sync-status-pill"
      className="hidden sm:inline-flex items-center gap-1.5 h-[24px] px-3 rounded-full bg-bg-secondary border border-border-subtle font-mono text-[11px] text-text-secondary hover:border-border disabled:opacity-60 transition-colors cursor-pointer"
    >
      {!syncing && lastSync && (
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" aria-hidden />
      )}
      {label}
    </button>
  )
}

function relativeTime(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}
