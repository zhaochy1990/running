import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getActivityLikes, likeActivity, unlikeActivity,
  type ActivityLiker,
} from '../api'

interface LikeButtonProps {
  teamId: string
  userId: string
  labelId: string
  initialCount: number
  initialLiked: boolean
  /** Top N liker display names from the bulk feed fetch (chronological order). */
  initialTopLikers?: string[]
  /** Display name of the currently signed-in user, used for optimistic updates. */
  currentUserDisplayName?: string | null
}

/**
 * 👍 toggle + inline list of likers.
 *
 * Optimistically updates count + inline name list on toggle; reverts and shows
 * an inline error pill if the network call fails. The full liker list is
 * lazy-fetched the first time the popover opens.
 */
export default function LikeButton({
  teamId, userId, labelId, initialCount, initialLiked,
  initialTopLikers, currentUserDisplayName,
}: LikeButtonProps) {
  const [liked, setLiked] = useState(initialLiked)
  const [count, setCount] = useState(initialCount)
  const [topLikers, setTopLikers] = useState<string[]>(initialTopLikers ?? [])
  const [pending, setPending] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [likers, setLikers] = useState<ActivityLiker[] | null>(null)
  const [likersLoading, setLikersLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Reset only when the *target activity* identity changes.
  const idKey = `${teamId}:${userId}:${labelId}`
  const prevKeyRef = useRef(idKey)
  useEffect(() => {
    if (prevKeyRef.current !== idKey) {
      prevKeyRef.current = idKey
      setLiked(initialLiked)
      setCount(initialCount)
      setTopLikers(initialTopLikers ?? [])
    }
  }, [idKey, initialLiked, initialCount, initialTopLikers])

  useEffect(() => {
    if (!popoverOpen) return
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [popoverOpen])

  const callerName = (currentUserDisplayName || '').trim() || '你'

  const inlineSummary = useMemo(() => {
    if (count === 0) return null
    const names = topLikers.slice(0, 3)
    if (names.length === 0) return `${count} 人赞过`
    if (count <= names.length) return `${names.join('、')} 赞过`
    return `${names.join('、')} 等 ${count} 人赞过`
  }, [count, topLikers])

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (pending) return
    setPending(true)
    setErr(null)
    const wasLiked = liked
    const wasCount = count
    const wasTop = topLikers
    // Optimistic
    setLiked(!wasLiked)
    setCount(Math.max(0, wasCount + (wasLiked ? -1 : 1)))
    if (wasLiked) {
      setTopLikers(wasTop.filter((n) => n !== callerName))
    } else if (!wasTop.includes(callerName)) {
      setTopLikers([...wasTop, callerName].slice(0, 3))
    }
    try {
      const fn = wasLiked ? unlikeActivity : likeActivity
      const res = await fn(teamId, userId, labelId)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setLiked(res.data.you_liked)
      setCount(res.data.count)
      // Invalidate cached liker list so next popover open refetches.
      setLikers(null)
    } catch (e: unknown) {
      setLiked(wasLiked)
      setCount(wasCount)
      setTopLikers(wasTop)
      setErr(e instanceof Error ? e.message : '操作失败')
    } finally {
      setPending(false)
    }
  }

  const handleOpenPopover = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (count === 0) return
    setPopoverOpen((v) => !v)
    if (likers !== null || likersLoading) return
    setLikersLoading(true)
    try {
      const data = await getActivityLikes(teamId, userId, labelId)
      setLikers(data.likers)
      setCount(data.count)
      setLiked(data.you_liked)
      setTopLikers(data.likers.slice(0, 3).map((l) => l.display_name))
    } catch {
      setLikers([])
    } finally {
      setLikersLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2 relative">
      <button
        type="button"
        onClick={handleToggle}
        disabled={pending}
        aria-pressed={liked}
        aria-label={liked ? '取消点赞' : '点赞'}
        className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-mono transition-colors disabled:opacity-50 ${
          liked
            ? 'text-accent-red bg-accent-red/10 hover:bg-accent-red/20'
            : 'text-text-muted hover:text-accent-red hover:bg-accent-red/5'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          className="w-4 h-4"
          fill={liked ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M7 22V11M2 13v7a2 2 0 0 0 2 2h3V11H4a2 2 0 0 0-2 2zM14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"
          />
        </svg>
        <span>{count}</span>
      </button>

      {inlineSummary && (
        <button
          type="button"
          onClick={handleOpenPopover}
          className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors truncate max-w-[280px] text-left"
          title={inlineSummary}
        >
          {inlineSummary}
        </button>
      )}

      {err && (
        <span className="text-[11px] font-mono text-accent-red">{err}</span>
      )}

      {popoverOpen && (
        <div
          ref={popoverRef}
          onClick={(e) => e.stopPropagation()}
          className="absolute top-full left-0 mt-2 z-20 min-w-[200px] max-w-[280px] rounded-lg border border-border bg-bg-card shadow-lg p-2"
        >
          <div className="text-[11px] font-mono text-text-muted px-2 pb-1 border-b border-border-subtle mb-1">
            点赞的人 ({count})
          </div>
          {likersLoading ? (
            <div className="text-xs text-text-muted px-2 py-2 font-mono">
              加载中...
            </div>
          ) : likers && likers.length > 0 ? (
            <ul className="max-h-48 overflow-y-auto">
              {likers.map((l) => (
                <li
                  key={l.user_id}
                  className="text-xs text-text-primary px-2 py-1 truncate"
                >
                  {l.display_name}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-text-muted px-2 py-2 font-mono">
              暂无
            </div>
          )}
        </div>
      )}
    </div>
  )
}
