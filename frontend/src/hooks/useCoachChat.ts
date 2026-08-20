/**
 * useCoachChat — drives a coach conversation thread (default web-default).
 *
 * Responsibilities:
 *  - Load full history once on mount (issue #221 tracks pagination), preserving
 *    each message's stable id / turn id / timestamp.
 *  - Optimistically append the user's message, then the coach reply.
 *  - Dedup by server message id / turn id so an HTTP replay (same
 *    client_turn_id) never double-appends the user or assistant turn.
 *  - Guard against empty/whitespace sends and concurrent in-flight sends.
 *  - Auto-replay a persisted pending turn after a successful history load, so a
 *    refresh mid-turn resumes with the same client_turn_id instead of losing it.
 *  - Surface send errors with a manual `retry()` as a fallback.
 *  - Workspace mode (via options): send the authoritative `target` on every
 *    turn, and show only the history at/after `contextAnchor` (the message id
 *    the adjust conversation resumes from). The full page passes neither and
 *    shows the entire transcript.
 *
 * Wire contract mirrors src/stride_server/routes/coach.py: the coach answer is
 * `reply`; assistant turns carry structured `parts` + `assistant_message`
 * identity; debug users additionally receive reasoning/tool_meta parts and raw
 * role="tool" turns.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchCoachHistory,
  sendCoachChatMessage,
  WEB_DEFAULT_SESSION_ID,
} from '../api'
import { useUser } from '../UserContextValue'
import { DEFAULT_COACH_CHAT_MAX_MESSAGE_CHARS } from '../types/coachChat'
import type {
  AssistantPart,
  ChatMessageView,
  CoachActiveTarget,
  CoachHistoryMessage,
  CoachProposalCard,
  CoachReviewContext,
  CoachTargetRef,
} from '../types/coachChat'

export interface UseCoachChatOptions {
  /** Authoritative target sent on every turn (workspace mode). */
  target?: CoachTargetRef
  /**
   * When set, only history at/after this message id is shown (workspace resumes
   * the conversation from the proposal's anchor). Omit for the full page.
   */
  contextAnchor?: string
  /**
   * Unapplied review draft anchored to every turn (Review workspace). When set,
   * the coach answers questions about the drafted plan from this draft instead
   * of a saved plan. Its proposal folder must match `target.folder`. Omit for an
   * ordinary chat that carries no draft context.
   */
  reviewContext?: CoachReviewContext
}

export interface CoachChatState {
  messages: ChatMessageView[]
  loading: boolean
  error: string | null
  sendMessage: (message: string) => void
  retry: () => void
  /** Pattern-Y write proposals from the latest coach turn (upgrade cards). */
  proposals?: CoachProposalCard[]
  /** Active plan target from the latest coach turn (upgrade entry w/o proposal). */
  activeTarget?: CoachActiveTarget | null
  /** Assistant message that originally produced the currently pending proposal. */
  proposalContextAnchor?: string | null
  /** True while the initial history load is in flight. */
  historyLoading?: boolean
  /** Set when the initial history load failed; blocks sending. */
  historyError?: string | null
  /** Retry the initial history load. */
  reloadHistory?: () => void
}

const PENDING_TURN_KEY = 'stride.coach.pendingTurn'

/**
 * A turn's frozen request identity — the exact inputs that define its server
 * idempotency fingerprint (`target` + `reviewContext`). `null` means the
 * original request explicitly had none; that is distinct from "unknown" (a
 * legacy pending record with no snapshot at all).
 */
interface TurnRequestSnapshot {
  target: CoachTargetRef | null
  reviewContext: CoachReviewContext | null
}

interface PendingTurn {
  sessionId: string
  clientTurnId: string
  message: string
  /**
   * Complete, explicit request snapshot persisted with the turn. A replay
   * (refresh / cross-page / manual retry) MUST reuse this verbatim — never the
   * live workspace refs — so the same client_turn_id can't 409 because the
   * remounted view now has a different target/draft. Absent only on a legacy
   * record written before this field existed.
   */
  requestSnapshot?: TurnRequestSnapshot
}

/** Normalise an optional value to the snapshot's explicit `null`. */
function snapshotValue<T>(value: T | undefined | null): T | null {
  return value ?? null
}

function newClientTurnId(): string {
  // crypto.randomUUID with hyphens stripped is a valid opaque token.
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return raw.replace(/-/g, '')
}

function readPendingTurn(
  maxMessageChars = DEFAULT_COACH_CHAT_MAX_MESSAGE_CHARS,
): PendingTurn | null {
  try {
    const raw = sessionStorage.getItem(PENDING_TURN_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingTurn> & {
      // Legacy field: a pre-snapshot build persisted only the review draft.
      reviewContext?: CoachReviewContext
    }
    if (
      typeof parsed.sessionId === 'string' &&
      typeof parsed.clientTurnId === 'string' &&
      typeof parsed.message === 'string'
    ) {
      if (parsed.message.length > maxMessageChars) {
        sessionStorage.removeItem(PENDING_TURN_KEY)
        return null
      }
      const base: PendingTurn = {
        sessionId: parsed.sessionId,
        clientTurnId: parsed.clientTurnId,
        message: parsed.message,
      }
      // Prefer the complete snapshot; fall back to reconstructing one from the
      // legacy `reviewContext`-only shape (target unknowable => null).
      const snap = parsed.requestSnapshot
      if (snap && typeof snap === 'object') {
        base.requestSnapshot = {
          target: snap.target && typeof snap.target === 'object' ? snap.target : null,
          reviewContext:
            snap.reviewContext && typeof snap.reviewContext === 'object'
              ? snap.reviewContext
              : null,
        }
      } else if (parsed.reviewContext && typeof parsed.reviewContext === 'object') {
        base.requestSnapshot = { target: null, reviewContext: parsed.reviewContext }
      }
      return base
    }
  } catch {
    /* ignore corrupt entry */
  }
  return null
}

function writePendingTurn(turn: PendingTurn): void {
  try {
    sessionStorage.setItem(PENDING_TURN_KEY, JSON.stringify(turn))
  } catch {
    /* sessionStorage unavailable — replay simply won't persist */
  }
}

function clearPendingTurn(): void {
  try {
    sessionStorage.removeItem(PENDING_TURN_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Drop a persisted pending turn when its weekly draft is applied or discarded.
 * Matching by the frozen request snapshot avoids clearing an
 * unrelated ordinary-chat retry that happens to share the global session.
 */
export function clearPendingCoachTurnForWeek(folder: string): void {
  const pending = readPendingTurn()
  if (!pending?.requestSnapshot) return
  const snapshot = pending.requestSnapshot
  const proposal = snapshot.reviewContext?.proposal
  const contextFolder =
    proposal && typeof proposal.folder === 'string' ? proposal.folder : null
  if (contextFolder === folder) clearPendingTurn()
}

/** Collapse assistant `parts` into user-facing text (final answer / refusal). */
function assistantText(parts: AssistantPart[]): { content: string; refusal: boolean } {
  const finals = parts.filter((p) => p.kind === 'text')
  const refusals = parts.filter((p) => p.kind === 'refusal')
  if (finals.length > 0) {
    return { content: finals.map((p) => p.text).join('\n\n'), refusal: false }
  }
  if (refusals.length > 0) {
    return { content: refusals.map((p) => p.text).join('\n\n'), refusal: true }
  }
  return { content: '', refusal: false }
}

function historyToViews(messages: CoachHistoryMessage[]): ChatMessageView[] {
  const views: ChatMessageView[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      views.push({
        role: 'user',
        content: m.content,
        messageId: m.message_id ?? null,
        turnId: m.turn_id ?? null,
        createdAt: m.created_at ?? null,
      })
    } else if (m.role === 'assistant') {
      const { content, refusal } = assistantText(m.parts)
      views.push({
        role: 'coach',
        content,
        parts: m.parts,
        refusal,
        messageId: m.message_id ?? null,
        turnId: m.turn_id ?? null,
        createdAt: m.created_at ?? null,
      })
    } else if (m.role === 'tool') {
      // Only present for debug users; rendered as a collapsed debug view.
      views.push({
        role: 'tool',
        content: m.content,
        toolName: m.name ?? null,
        messageId: m.message_id ?? null,
        createdAt: m.created_at ?? null,
      })
    } else if (m.role === 'event') {
      // Trusted system receipt (plan applied / abandoned) — shown to everyone
      // as a compact status bar, never as markdown / assistant text.
      views.push({
        role: 'event',
        content: m.summary ?? '',
        eventType: m.event_type ?? null,
        eventStatus: m.status ?? null,
        eventDetail: m.detail ?? null,
        messageId: m.message_id ?? null,
        createdAt: m.created_at ?? null,
      })
    }
    // system turns are never rendered.
  }
  return views
}

/**
 * Slice history to the anchor: keep messages at/after the message whose id
 * equals `contextAnchor`. Unknown / empty anchor => full history.
 */
function sliceFromAnchor(views: ChatMessageView[], anchor?: string): ChatMessageView[] {
  if (!anchor) return views
  const idx = views.findIndex((v) => v.messageId === anchor)
  return idx >= 0 ? views.slice(idx) : views
}

export function useCoachChat(options: UseCoachChatOptions = {}): CoachChatState {
  const { target, contextAnchor, reviewContext } = options
  const { user, coachChatMaxMessageChars } = useUser()
  const maxMessageChars =
    coachChatMaxMessageChars ?? DEFAULT_COACH_CHAT_MAX_MESSAGE_CHARS
  const [messages, setMessages] = useState<ChatMessageView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const [proposals, setProposals] = useState<CoachProposalCard[]>([])
  const [activeTarget, setActiveTarget] = useState<CoachActiveTarget | null>(null)
  const [proposalContextAnchor, setProposalContextAnchor] = useState<string | null>(null)

  // Refs mirror the latest values so the send closure can read them without
  // being re-created on every state change (which would break the in-flight
  // guard's identity for concurrent-call tests).
  const loadingRef = useRef(false)
  const lastUserMessageRef = useRef<string | null>(null)
  // Server message / turn ids already appended, so a replay never doubles up.
  const seenIdsRef = useRef<Set<string>>(new Set())
  const targetRef = useRef<CoachTargetRef | undefined>(target)
  targetRef.current = target
  // Latest review draft to anchor turns to. Each turn freezes a complete request
  // snapshot (target + context) at send time; a retry/replay reuses that frozen
  // snapshot — never these live refs — so the server idempotency fingerprint for
  // one client_turn_id can't drift if the workspace remounts with a different
  // target/draft.
  const reviewContextRef = useRef<CoachReviewContext | undefined>(reviewContext)
  reviewContextRef.current = reviewContext
  const lastTurnSnapshotRef = useRef<TurnRequestSnapshot | null>(null)

  /** Append a coach turn, deduping by message id / turn id. */
  const appendCoachTurn = useCallback(
    (data: {
      reply: string
      clarification?: string | null
      messageId?: string | null
      turnId?: string | null
      parts?: AssistantPart[]
      createdAt?: string | null
    }) => {
      const dedupKey = data.messageId ?? data.turnId ?? null
      if (dedupKey && seenIdsRef.current.has(dedupKey)) return
      if (dedupKey) seenIdsRef.current.add(dedupKey)
      const refusal = Boolean(data.clarification) && !data.reply
      setMessages((prev) => [
        ...prev,
        {
          role: 'coach',
          content: data.reply || data.clarification || '',
          refusal,
          parts: data.parts,
          messageId: data.messageId ?? null,
          turnId: data.turnId ?? null,
          createdAt: data.createdAt ?? null,
        },
      ])
    },
    [],
  )

  const runTurn = useCallback(
    async (message: string, turn: PendingTurn, snapshot: TurnRequestSnapshot) => {
      loadingRef.current = true
      setLoading(true)
      setError(null)
      // Freeze this turn's request identity so a manual retry replays the exact
      // same request (same server idempotency fingerprint).
      lastTurnSnapshotRef.current = snapshot
      try {
        const res = await sendCoachChatMessage(
          message,
          turn.clientTurnId,
          turn.sessionId,
          snapshot.target ?? undefined,
          snapshot.reviewContext ?? undefined,
        )
        if (res.ok) {
          const am = res.data.assistant_message
          appendCoachTurn({
            reply: res.data.reply,
            clarification: res.data.clarification,
            messageId: am?.message_id ?? null,
            turnId: am?.turn_id ?? turn.clientTurnId,
            parts: am?.parts,
            createdAt: am?.created_at ?? null,
          })
          const nextProposals = res.data.proposals ?? []
          if (nextProposals.length > 0) {
            setProposals(nextProposals)
            setProposalContextAnchor(am?.message_id ?? null)
          }
          // A read-only follow-up must not erase a still-pending proposal card.
          // A newer proposal replaces it; apply/abandon resolves it server-side.
          if (res.data.active_target) setActiveTarget(res.data.active_target)
          clearPendingTurn()
        } else {
          setError('Coach 暂时不可用，请稍后重试')
        }
      } catch {
        setError('网络错误，请重试')
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
    },
    [appendCoachTurn],
  )

  // ── Initial history load (+ auto-replay of a persisted pending turn) ──────
  useEffect(() => {
    if (!user) return
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(null)
    void fetchCoachHistory(WEB_DEFAULT_SESSION_ID)
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setHistoryError('加载对话历史失败，请重试')
          return
        }
        const views = sliceFromAnchor(historyToViews(res.data.messages ?? []), contextAnchor)
        setMessages(views)
        // Seed the dedup set from loaded ids.
        const seen = new Set<string>()
        for (const v of views) {
          if (v.messageId) seen.add(v.messageId)
          if (v.turnId) seen.add(v.turnId)
        }
        seenIdsRef.current = seen

        // Restore pending proposal from checkpoint so the Review card re-appears
        // after a refresh or new tab.  A subsequent send turn will overwrite these.
        const pendingProposals = res.data.pending_proposals ?? []
        setProposals(pendingProposals)
        if (pendingProposals.length > 0) {
          setActiveTarget(res.data.pending_active_target ?? null)
          setProposalContextAnchor(res.data.pending_proposal_message_id ?? null)
        } else {
          setActiveTarget(null)
          setProposalContextAnchor(null)
        }

        // Auto-replay: a pending turn survived a refresh — resend it with the
        // same client_turn_id (server idempotency dedupes the model call).
        const pending = readPendingTurn(maxMessageChars)
        if (pending && !loadingRef.current) {
          const alreadyEchoed = seen.has(pending.clientTurnId)
          if (alreadyEchoed) {
            // The turn already landed server-side; just drop the pending record.
            clearPendingTurn()
          } else {
            lastUserMessageRef.current = pending.message
            const hasUserMsg = views.some(
              (v) => v.role === 'user' && v.content === pending.message,
            )
            if (!hasUserMsg) {
              setMessages((prev) => [...prev, { role: 'user', content: pending.message }])
            }
            // Replay with the turn's own frozen request snapshot so the same
            // client_turn_id reproduces the exact original request. Only a legacy
            // record (no snapshot) falls back to the live refs.
            const snapshot: TurnRequestSnapshot = pending.requestSnapshot ?? {
              target: snapshotValue(targetRef.current),
              reviewContext: snapshotValue(reviewContextRef.current),
            }
            void runTurn(pending.message, pending, snapshot)
          }
        }
      })
      .catch(() => {
        if (!cancelled) setHistoryError('加载对话历史失败，请重试')
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false)
      })
    return () => {
      cancelled = true
    }
    // runTurn / contextAnchor are stable for a given mount; re-run only on user
    // change or an explicit reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, historyAttempt, maxMessageChars])

  const reloadHistory = useCallback(() => {
    setHistoryAttempt((n) => n + 1)
  }, [])

  const sendMessage = useCallback(
    (message: string) => {
      if (loadingRef.current) return
      const trimmed = message.trim()
      if (!trimmed || trimmed.length > maxMessageChars) return

      lastUserMessageRef.current = trimmed
      // Freeze the full request identity for this turn (explicit null when none).
      const snapshot: TurnRequestSnapshot = {
        target: snapshotValue(targetRef.current),
        reviewContext: snapshotValue(reviewContextRef.current),
      }
      const turn: PendingTurn = {
        sessionId: WEB_DEFAULT_SESSION_ID,
        clientTurnId: newClientTurnId(),
        message: trimmed,
        requestSnapshot: snapshot,
      }
      writePendingTurn(turn)
      setMessages((prev) => [...prev, { role: 'user', content: trimmed }])
      void runTurn(trimmed, turn, snapshot)
    },
    [maxMessageChars, runTurn],
  )

  const retry = useCallback(() => {
    if (loadingRef.current) return
    const last = lastUserMessageRef.current
    if (!last) return
    // Reuse the pending turn id AND its frozen request snapshot when present so
    // the replay reproduces the identical request (same idempotency fingerprint);
    // never fall back to the live refs for a turn we already sent.
    const pending = readPendingTurn(maxMessageChars)
    const reuse = pending && pending.message === last
    const snapshot: TurnRequestSnapshot =
      (reuse ? pending.requestSnapshot : null) ??
      lastTurnSnapshotRef.current ?? {
        target: snapshotValue(targetRef.current),
        reviewContext: snapshotValue(reviewContextRef.current),
      }
    const turn: PendingTurn = reuse
      ? { ...pending, requestSnapshot: snapshot }
      : {
          sessionId: WEB_DEFAULT_SESSION_ID,
          clientTurnId: newClientTurnId(),
          message: last,
          requestSnapshot: snapshot,
        }
    writePendingTurn(turn)
    void runTurn(last, turn, snapshot)
  }, [maxMessageChars, runTurn])

  return useMemo(
    () => ({
      messages,
      loading,
      error,
      sendMessage,
      retry,
      proposals,
      activeTarget,
      proposalContextAnchor,
      historyLoading,
      historyError,
      reloadHistory,
    }),
    [
      messages,
      loading,
      error,
      sendMessage,
      retry,
      proposals,
      activeTarget,
      proposalContextAnchor,
      historyLoading,
      historyError,
      reloadHistory,
    ],
  )
}
