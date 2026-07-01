import type { CoachProposalCard } from '../../api'

/** One rendered conversation turn in the coach chat UI. */
export interface ChatTurn {
  id: string
  role: 'user' | 'coach'
  /** Markdown for coach turns; plain text for user turns. */
  text: string
  /** Pattern-Y write proposals attached to a coach turn (empty for clarify turns). */
  proposals?: CoachProposalCard[]
  /** Non-null when the coach asked for clarification this turn. */
  clarification?: string | null
  /** Coach turn placeholder while the request is in flight. */
  pending?: boolean
  /** Coach turn failed (text holds the user-facing error). */
  error?: boolean
}
