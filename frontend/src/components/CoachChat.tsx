/**
 * CoachChat — the reusable conversation panel (transcript + composer).
 *
 * This is the injectable node used both by the full-page `/coach` view and by
 * the plan-adjust workspace's right column (`chat` prop). It owns its own
 * `useCoachChat` state, so it is self-contained.
 *
 * WorkspaceLayout mounts this node exactly once and changes only its responsive
 * presentation (docked column or modal drawer), so one conversation state is
 * preserved across viewport changes.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import CoachChatMessage from './CoachChatMessage'
import CoachProposalUpgradeCard from './CoachProposalUpgradeCard'
import { useCoachChat } from '../hooks/useCoachChat'
import { useUser } from '../UserContextValue'
import type { CoachTargetRef } from '../types/coachChat'

const DEFAULT_MAX_MESSAGE_CHARS = 8000
const TEXTAREA_MAX_HEIGHT_PX = 120

export interface CoachChatProps {
  /**
   * Authoritative target the workspace conversation acts on. Sent on every
   * turn; omit for the full page.
   */
  target?: CoachTargetRef
  /**
   * When rendered inside the adjust workspace, the message id the conversation
   * resumes from — history before it is hidden. Omit for the full page.
   */
  contextAnchor?: string
}

export default function CoachChat({ target, contextAnchor }: CoachChatProps) {
  const { user, coachChatDebug, coachChatMaxMessageChars } = useUser()
  const {
    messages,
    loading,
    error,
    sendMessage,
    retry,
    proposals,
    activeTarget,
    historyLoading,
    historyError,
    reloadHistory,
  } = useCoachChat({ target, contextAnchor })

  const maxChars = coachChatMaxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const trimmed = draft.trim()
  const overLimit = draft.length > maxChars
  const historyBlocked = Boolean(historyError)
  const canSend = trimmed.length > 0 && !loading && !overLimit && !historyBlocked

  // Auto-resize the textarea up to a fixed cap, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`
  }, [draft])

  // Keep the transcript pinned to the latest turn.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, loading])

  const handleSend = () => {
    if (!canSend) return
    sendMessage(trimmed)
    setDraft('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+Enter sends; bare Enter inserts a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  const hasProposals = Boolean(proposals && proposals.length > 0)
  const multiProposal = Boolean(proposals && proposals.length > 1)
  const showUpgrade = hasProposals || Boolean(activeTarget)

  // The message id the workspace should resume from: the latest coach turn's
  // stable server message id, when present.
  const latestCoachAnchor = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m.role === 'coach' && m.messageId) return m.messageId
    }
    return ''
  }, [messages])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Scrollable transcript + controls. Only message/status content is live. */}
      <div ref={logRef} className="flex-1 space-y-4 overflow-y-auto px-1 pb-2">
        <div
          role="log"
          aria-live="polite"
          aria-label="Coach 对话记录"
          className="space-y-4"
        >
          {historyLoading ? (
            <div className="flex items-center justify-center py-10" aria-busy="true">
              <div
                aria-hidden
                className="h-5 w-5 animate-spin rounded-full border-2 border-accent-green/30 border-t-accent-green"
              />
              <span className="sr-only">加载对话历史中…</span>
            </div>
          ) : null}

          {!historyLoading && !historyError && messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-muted">
              还没有对话。向 Coach 提出你的第一个问题。
            </p>
          ) : null}

          {messages
            .filter((m) => m.role !== 'tool' || coachChatDebug)
            .map((m, i) => (
              <CoachChatMessage
                key={m.messageId ?? `idx-${i}`}
                role={m.role}
                content={m.content}
                refusal={m.refusal}
                parts={m.parts}
                toolName={m.toolName}
                eventStatus={m.eventStatus}
                showDebug={Boolean(coachChatDebug)}
              />
            ))}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-text-muted" aria-busy="true">
              <div
                aria-hidden
                className="h-4 w-4 animate-spin rounded-full border-2 border-accent-green/30 border-t-accent-green"
              />
              <span>Coach 正在分析，请保持页面打开…</span>
            </div>
          ) : null}
        </div>

        {historyError ? (
          <div
            role="alert"
            className="rounded-lg border border-accent-red/30 bg-red-soft p-4 text-sm text-accent-red"
          >
            <p>{historyError}</p>
            <button
              type="button"
              onClick={() => reloadHistory?.()}
              className="mt-2 rounded-md border border-accent-red/40 px-3 py-1.5 text-sm text-accent-red hover:bg-accent-red/10"
            >
              重试加载历史
            </button>
          </div>
        ) : null}

        {showUpgrade ? (
          <div className="space-y-2">
            {multiProposal ? (
              <p className="text-sm font-medium text-text-primary">选择一个调整方案</p>
            ) : null}
            {hasProposals ? (
              proposals!.map((p, i) => (
                <CoachProposalUpgradeCard
                  key={i}
                  userId={user}
                  proposal={p}
                  contextAnchor={latestCoachAnchor}
                />
              ))
            ) : (
              <CoachProposalUpgradeCard
                userId={user}
                activeTarget={activeTarget}
                contextAnchor={latestCoachAnchor}
              />
            )}
          </div>
        ) : null}
      </div>

      {/* Send error */}
      {error ? (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-accent-red/30 bg-red-soft px-3.5 py-2 text-sm text-accent-red">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => retry()}
            className="flex-shrink-0 rounded-md border border-accent-red/40 px-3 py-1 text-sm text-accent-red hover:bg-accent-red/10"
          >
            重试
          </button>
        </div>
      ) : null}

      {/* Composer */}
      <div className="mt-3 flex-shrink-0">
        <label htmlFor="coach-chat-input" className="sr-only">
          向 Coach 提问
        </label>
        <div className="rounded-lg border border-border-subtle bg-bg-card focus-within:border-accent-green/50">
          <textarea
            id="coach-chat-input"
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="向 Coach 继续提问..."
            aria-label="向 Coach 提问"
            rows={1}
            disabled={loading || historyBlocked}
            className="block w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-60"
            style={{ maxHeight: TEXTAREA_MAX_HEIGHT_PX }}
          />
          <div className="flex items-center justify-between border-t border-border-subtle px-3.5 py-2">
            <span className={`text-xs font-mono ${overLimit ? 'text-accent-red' : 'text-text-muted'}`}>
              {draft.length} / {maxChars}
            </span>
            <button
              type="button"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="发送给 Coach"
              className="rounded-md bg-accent-green-dim px-4 py-1.5 text-sm font-medium text-black transition-colors hover:bg-accent-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-green disabled:cursor-not-allowed disabled:opacity-50"
            >
              发送给 Coach
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-xs text-text-muted">Enter 换行，Ctrl/Cmd + Enter 发送。</p>
      </div>
    </div>
  )
}
