import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatTurn } from './types'
import type { CoachProposalCard } from '../../api'
import ProposalCardInline from './ProposalCardInline'

interface ChatThreadProps {
  turns: ChatTurn[]
  appliedProposalIds: Set<string>
  onReviewProposal: (card: CoachProposalCard) => void
  /** Compact mode for the review-mode right rail. */
  compact?: boolean
}

const CoachAvatar = () => (
  <div className="w-7 h-7 rounded-full bg-accent-green flex items-center justify-center flex-shrink-0">
    <span className="text-white text-xs font-bold font-mono">S</span>
  </div>
)

function ThinkingBubble() {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl border border-border-subtle bg-bg-card">
      <span className="w-1.5 h-1.5 rounded-full bg-accent-green/60 animate-bounce [animation-delay:-0.3s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-accent-green/60 animate-bounce [animation-delay:-0.15s]" />
      <span className="w-1.5 h-1.5 rounded-full bg-accent-green/60 animate-bounce" />
      <span className="ml-1.5 font-mono text-[10px] text-text-muted tracking-wide">教练思考中…</span>
    </div>
  )
}

function CoachTurnView({
  turn,
  appliedProposalIds,
  onReviewProposal,
  compact,
}: {
  turn: ChatTurn
  appliedProposalIds: Set<string>
  onReviewProposal: (card: CoachProposalCard) => void
  compact?: boolean
}) {
  if (turn.pending) {
    return (
      <div className="flex items-start gap-2.5">
        <CoachAvatar />
        <ThinkingBubble />
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2.5">
      <CoachAvatar />
      <div className={`min-w-0 ${compact ? 'max-w-full' : 'max-w-[680px]'}`}>
        <div
          className={`rounded-xl border bg-bg-card px-3.5 py-2.5 ${
            turn.error ? 'border-accent-red/30' : 'border-border-subtle'
          }`}
        >
          {turn.error ? (
            <p className="text-[13px] text-accent-red m-0">{turn.text}</p>
          ) : (
            <div className="prose max-w-none text-[13px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.text}</ReactMarkdown>
            </div>
          )}
        </div>
        {turn.clarification && (
          <div className="mt-2 rounded-xl border border-accent-amber/30 bg-accent-amber/5 px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent-amber">需要澄清</span>
            <p className="text-[13px] text-text-secondary mt-1 m-0">{turn.clarification}</p>
          </div>
        )}
        {!turn.clarification &&
          (turn.proposals ?? []).map((card, i) => (
            <ProposalCardInline
              key={`${turn.id}-${i}`}
              card={card}
              applied={appliedProposalIds.has(`${turn.id}-${i}`)}
              onReview={() => onReviewProposal(card)}
            />
          ))}
      </div>
    </div>
  )
}

function UserTurnView({ turn }: { turn: ChatTurn }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-xl border border-green-edge bg-green-soft px-3.5 py-2.5">
        <p className="text-[13px] text-text-primary whitespace-pre-wrap m-0">{turn.text}</p>
      </div>
    </div>
  )
}

export default function ChatThread({ turns, appliedProposalIds, onReviewProposal, compact }: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
  }, [turns])

  return (
    <div className={`flex flex-col gap-4 ${compact ? 'text-[12px]' : ''}`}>
      {turns.map((turn) =>
        turn.role === 'coach' ? (
          <CoachTurnView
            key={turn.id}
            turn={turn}
            appliedProposalIds={appliedProposalIds}
            onReviewProposal={onReviewProposal}
            compact={compact}
          />
        ) : (
          <UserTurnView key={turn.id} turn={turn} />
        ),
      )}
      <div ref={endRef} />
    </div>
  )
}
