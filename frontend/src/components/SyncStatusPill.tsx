import { useState, useEffect, useCallback, useRef } from 'react'
import { getPipelineRun, triggerSync, getWatchInfo } from '../api'
import { SYNC_COMPLETED_EVENT } from '../lib/syncEvents'
import { useUser } from '../UserContextValue'

const PIPELINE_POLL_MS = 2000
const PIPELINE_TIMEOUT_MS = 60 * 60 * 1000

export default function SyncStatusPill() {
  const { user } = useUser()
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(false)
  const [tick, setTick] = useState(0)
  const requestIdRef = useRef(0)

  const refreshLastSync = useCallback(async () => {
    if (!user) return
    const myId = ++requestIdRef.current
    try {
      const info = await getWatchInfo()
      // Discard stale responses — a slow initial fetch may resolve after
      // a fresher post-sync fetch and would otherwise overwrite it.
      if (myId === requestIdRef.current) {
        setLastSync(info.last_sync_at)
      }
    } catch {
      // leave previous value; transient error
    }
  }, [user])

  useEffect(() => {
    refreshLastSync()
  }, [refreshLastSync])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  void tick

  const handleClick = async () => {
    if (syncing || !user) return
    setSyncing(true)
    setSyncError(false)
    try {
      const res = await triggerSync(user, { full: false })
      if (!res.ok) throw new Error(res.data.error || `HTTP ${res.status}`)
      if (!res.data.run_id) throw new Error('同步任务未返回 run_id')

      const deadline = Date.now() + PIPELINE_TIMEOUT_MS
      let completed = false
      while (Date.now() < deadline) {
        const run = await getPipelineRun(res.data.run_id)
        if (run.status === 'done') {
          completed = true
          break
        }
        if (run.status === 'failed') throw new Error(run.error_message || '同步失败')
        await new Promise((resolve) => window.setTimeout(resolve, PIPELINE_POLL_MS))
      }
      if (!completed) throw new Error('同步超时')

      await refreshLastSync()
      window.dispatchEvent(new Event(SYNC_COMPLETED_EVENT))
    } catch {
      setSyncError(true)
    } finally {
      setSyncing(false)
    }
  }

  const lastSyncMs = lastSync ? Date.parse(lastSync) : NaN
  const haveLastSync = Number.isFinite(lastSyncMs)
  const label = syncing
    ? '同步中...'
    : syncError
      ? '同步失败 · 重试'
    : haveLastSync
      ? `已同步 · ${relativeTime(Date.now() - lastSyncMs)}`
      : '未同步'

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={syncing}
      data-testid="sync-status-pill"
      className="inline-flex items-center gap-1.5 h-[24px] px-3 rounded-full bg-bg-secondary border border-border-subtle font-mono text-[11px] text-text-secondary hover:border-border disabled:opacity-60 transition-colors cursor-pointer"
    >
      {!syncing && haveLastSync && (
        <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" aria-hidden />
      )}
      {label}
    </button>
  )
}

function relativeTime(ms: number): string {
  if (ms < 0) ms = 0
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}
