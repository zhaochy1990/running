import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getCoachThread,
  getStrideTrainingLoad,
  sendCoachChat,
  type CoachProposalCard,
  type CoachTargetRef,
  type StrideTrainingLoadRecord,
} from '../api'
import { useUser } from '../UserContextValue'
import {
  coachThreadId,
  deriveTitle,
  loadSessions,
  newSessionId,
  saveSession,
  type CoachSessionMeta,
} from '../lib/coachSession'
import ChatThread from '../components/coach/ChatThread'
import Composer from '../components/coach/Composer'
import ContextDock from '../components/coach/ContextDock'
import EmptyState from '../components/coach/EmptyState'
import ReviewMode from '../components/coach/ReviewMode'
import SessionSwitcher from '../components/coach/SessionSwitcher'
import { applyProposal, type ApplyOutcome } from '../components/coach/diffHelpers'
import type { ChatTurn } from '../components/coach/types'

interface ReviewState {
  card: CoachProposalCard
  turnIdx: number
  proposalIdx: number
}

let turnSeq = 0
const nextTurnId = () => `t${turnSeq++}`

export default function CoachChatPage() {
  const { user } = useUser()

  const [sessions, setSessions] = useState<CoachSessionMeta[]>([])
  const [sessionId, setSessionId] = useState<string>('')
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [activeTarget, setActiveTarget] = useState<CoachTargetRef | null>(null)
  const [load, setLoad] = useState<StrideTrainingLoadRecord | null>(null)
  const [sending, setSending] = useState(false)

  // Review-mode state
  const [review, setReview] = useState<ReviewState | null>(null)
  const [selectedOpIds, setSelectedOpIds] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyOutcome, setApplyOutcome] = useState<ApplyOutcome | null>(null)
  const [appliedProposalIds, setAppliedProposalIds] = useState<Set<string>>(new Set())

  // Initialize session list + active session once we know the user.
  useEffect(() => {
    if (!user) return
    const list = loadSessions(user)
    setSessions(list)
    setSessionId(list[0]?.sessionId ?? newSessionId())
  }, [user])

  // Lightweight context for the dock (current training load).
  useEffect(() => {
    if (!user) return
    let cancelled = false
    // days has a ge=7 floor on the backend; we only need `.current`.
    getStrideTrainingLoad(user, 7)
      .then((res) => {
        if (!cancelled) setLoad(res.current)
      })
      .catch(() => {
        /* dock degrades gracefully without load */
      })
    return () => {
      cancelled = true
    }
  }, [user])

  // Load history when the active session changes (server is source of truth).
  useEffect(() => {
    if (!user || !sessionId) return
    let cancelled = false
    setTurns([])
    setReview(null)
    setActiveTarget(null) // switching conversations clears the locked target
    getCoachThread(coachThreadId(user, sessionId))
      .then((res) => {
        if (cancelled) return
        const loaded: ChatTurn[] = res.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => {
            if (m.role === 'user') {
              return { id: nextTurnId(), role: 'user' as const, text: m.content }
            }
            const text = m.parts
              .filter((p) => p.kind === 'text' || p.kind === 'refusal')
              .map((p) => p.text)
              .join('\n\n')
            return { id: nextTurnId(), role: 'coach' as const, text }
          })
          .filter((t) => t.text.trim().length > 0)
        setTurns(loaded)
      })
      .catch(() => {
        /* new/empty session — nothing to load */
      })
    return () => {
      cancelled = true
    }
  }, [user, sessionId])

  const send = useCallback(
    async (message: string) => {
      if (!user || !sessionId || sending) return
      const userTurn: ChatTurn = { id: nextTurnId(), role: 'user', text: message }
      const pendingTurn: ChatTurn = { id: nextTurnId(), role: 'coach', text: '', pending: true }
      setTurns((prev) => [...prev, userTurn, pendingTurn])
      setSending(true)

      // Persist/refresh the session entry (title from the first user message).
      setSessions((prev) => {
        const existing = prev.find((s) => s.sessionId === sessionId)
        const title = existing?.title ?? deriveTitle(message)
        return saveSession(user, { sessionId, title, lastUsed: new Date().toISOString() })
      })

      try {
        const res = await sendCoachChat(sessionId, message)
        if (!res.ok) {
          const detail =
            res.status === 503
              ? 'AI 教练当前不可用，请稍后重试。'
              : `请求失败（HTTP ${res.status}）。`
          setTurns((prev) =>
            prev.map((t) => (t.id === pendingTurn.id ? { ...t, pending: false, error: true, text: detail } : t)),
          )
          return
        }
        const data = res.data
        // Keep the last locked target — a read-only turn (status / Q&A) returns
        // active_target=null and must not clear what the user is working on.
        setActiveTarget((prev) => data.active_target ?? prev)
        setTurns((prev) =>
          prev.map((t) =>
            t.id === pendingTurn.id
              ? {
                  ...t,
                  pending: false,
                  text: data.reply,
                  clarification: data.clarification,
                  proposals: data.clarification ? [] : data.proposals,
                }
              : t,
          ),
        )
      } catch {
        setTurns((prev) =>
          prev.map((t) =>
            t.id === pendingTurn.id
              ? { ...t, pending: false, error: true, text: '网络错误，请稍后重试。' }
              : t,
          ),
        )
      } finally {
        setSending(false)
      }
    },
    [user, sessionId, sending],
  )

  const startNewSession = useCallback(() => {
    setSessionId(newSessionId())
    setTurns([])
    setActiveTarget(null)
    setReview(null)
  }, [])

  const openReview = useCallback(
    (card: CoachProposalCard) => {
      // Locate the turn/proposal indices so we can mark it applied later.
      let turnIdx = -1
      let proposalIdx = -1
      turns.forEach((t, ti) => {
        ;(t.proposals ?? []).forEach((p, pi) => {
          if (p === card) {
            turnIdx = ti
            proposalIdx = pi
          }
        })
      })
      setReview({ card, turnIdx, proposalIdx })
      setSelectedOpIds(new Set(card.proposal.ops.map((op) => op.id)))
      setApplyError(null)
      setApplyOutcome(null)
    },
    [turns],
  )

  const toggleOp = useCallback((opId: string) => {
    setSelectedOpIds((prev) => {
      const next = new Set(prev)
      if (next.has(opId)) next.delete(opId)
      else next.add(opId)
      return next
    })
  }, [])

  const applyReview = useCallback(async () => {
    if (!review) return
    setApplying(true)
    setApplyError(null)
    try {
      const outcome = await applyProposal(review.card, Array.from(selectedOpIds))
      if (!outcome.ok) {
        setApplyError(
          outcome.status === 400
            ? '调整数据非法或已过期，请回到对话重新生成提案。'
            : `应用失败（HTTP ${outcome.status}）。`,
        )
        return
      }
      setApplyOutcome(outcome)
      if (review.turnIdx >= 0) {
        setAppliedProposalIds((prev) => new Set(prev).add(`${turns[review.turnIdx].id}-${review.proposalIdx}`))
      }
    } catch {
      setApplyError('网络错误，应用失败。')
    } finally {
      setApplying(false)
    }
  }, [review, selectedOpIds, turns])

  const latestProposals = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const p = turns[i].proposals
      if (p && p.length > 0) return p
    }
    return [] as CoachProposalCard[]
  }, [turns])

  if (!user) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  const inReview = review !== null

  return (
    <div className="flex h-full min-h-0">
      {/* Main column: conversation (chat mode) OR proposal review (review mode) */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-border-subtle">
          <SessionSwitcher
            sessions={sessions}
            activeSessionId={sessionId}
            onSelect={setSessionId}
            onNew={startNewSession}
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-green hidden sm:block">
            AI 教练
          </span>
        </header>

        {inReview ? (
          <div className="flex flex-1 min-h-0">
            <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
              <ReviewMode
                card={review.card}
                selectedOpIds={selectedOpIds}
                onToggleOp={toggleOp}
                onApply={applyReview}
                onBack={() => setReview(null)}
                applying={applying}
                applyError={applyError}
                applyOutcome={applyOutcome}
              />
            </div>
            {/* Conversation collapses to a right rail in review mode */}
            <aside className="w-[320px] flex-shrink-0 border-l border-border-subtle bg-bg-card overflow-y-auto p-3 hidden lg:block">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted mb-3">对话</div>
              <ChatThread
                turns={turns}
                appliedProposalIds={appliedProposalIds}
                onReviewProposal={openReview}
                compact
              />
            </aside>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4">
            {turns.length === 0 ? (
              <EmptyState onPick={send} />
            ) : (
              <div className="max-w-[860px] mx-auto">
                <ChatThread
                  turns={turns}
                  appliedProposalIds={appliedProposalIds}
                  onReviewProposal={openReview}
                />
              </div>
            )}
          </div>
        )}

        {!inReview && (
          <div className="border-t border-border-subtle px-4 sm:px-6 py-3">
            <div className="max-w-[860px] mx-auto">
              <Composer onSend={send} disabled={sending} />
            </div>
          </div>
        )}
      </div>

      {/* Right context dock — default (chat) mode only */}
      {!inReview && <ContextDock activeTarget={activeTarget} load={load} proposals={latestProposals} />}
    </div>
  )
}
