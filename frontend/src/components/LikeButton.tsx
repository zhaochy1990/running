import { useEffect, useRef, useState } from 'react'
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
}

/**
 * Heart toggle + click-to-expand list of likers.
 *
 * Optimistically updates count on toggle; reverts and shows an inline error
 * pill if the network call fails. The liker list is lazy-fetched the first
 * time the popover opens to avoid an N+1 on the team feed render.
 */
export default function LikeButton({
  teamId, userId, labelId, initialCount, initialLiked,
}: LikeButtonProps) {
  const [liked, setLiked] = useState(initialLiked)
  const [count, setCount] = useState(initialCount)
  const [pending, setPending] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [likers, setLikers] = useState<ActivityLiker[] | null>(null)
  const [likersLoading, setLikersLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)

  // Reset only when the *target activity* identity changes (e.g. user
  // navigates between teams or the parent re-keys). Don't sync on every
  // initialLiked/initialCount change — that would clobber an in-flight
  // optimistic update if the parent reloaded the feed for an unrelated
  // reason. The component re-mounts (via React's key) when the parent
  // wants a hard reset.
  const idKey = `${teamId}:${userId}:${labelId}`
  const prevKeyRef = useRef(idKey)
  useEffect(() => {
    if (prevKeyRef.current !== idKey) {
      prevKeyRef.current = idKey
      setLiked(initialLiked)
      setCount(initialCount)
    }
  }, [idKey, initialLiked, initialCount])

  // Close popover on outside click.
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

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (pending) return
    setPending(true)
    setErr(null)
    const wasLiked = liked
    const wasCount = count
    // Optimistic
    setLiked(!wasLiked)
    setCount(Math.max(0, wasCount + (wasLiked ? -1 : 1)))
    try {
      const fn = wasLiked ? unlikeActivity : likeActivity
      const res = await fn(teamId, userId, labelId)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setLiked(res.data.you_liked)
      setCount(res.data.count)
      // Invalidate cached liker list so next popover open refetches.
      setLikers(null)
    } catch (e: unknown) {
      // Revert on failure.
      setLiked(wasLiked)
      setCount(wasCount)
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
    } catch {
      setLikers([])
    } finally {
      setLikersLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2 mt-2 relative">
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
            d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
          />
        </svg>
        <span>{count}</span>
      </button>

      {count > 0 && (
        <button
          type="button"
          onClick={handleOpenPopover}
          className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors"
        >
          {liked && count === 1 ? '你赞过' : `${count} 人赞过`}
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
