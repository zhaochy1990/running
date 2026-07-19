/**
 * Coach chat wire types — the public contract of the coach conversation
 * endpoints. These mirror `src/stride_server/routes/coach.py`:
 *
 *   POST /api/users/me/coach/chat                        -> ChatResponse
 *   GET  /api/users/me/coach/sessions/{id}/messages      -> SessionHistoryResponse
 *
 * External JSON is always given an explicit shape here; never `any`.
 */

// ── Assistant renderable parts (coach.schemas.conversation.AssistantPart) ──

export type AssistantPartKind = 'text' | 'reasoning' | 'refusal' | 'tool_meta'
export type AssistantTextPhase = 'commentary' | 'final_answer'

export interface AssistantPart {
  kind: AssistantPartKind
  text: string
  /** Only meaningful for `kind==='text'`. */
  phase?: AssistantTextPhase | null
  annotations?: ReadonlyArray<Record<string, unknown>>
  /** Original OpenAI block id — debug/audit only, never rendered directly. */
  id?: string | null
}

// ── History message (coach.py ChatMessage) ──────────────────────────────────

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'event'

/**
 * Trusted system receipt kind (role="event"). `weekly_plan_applied` /
 * `master_plan_applied` land a plan; `proposal_abandoned` records a discard.
 */
export type CoachEventType =
  | 'weekly_plan_applied'
  | 'master_plan_applied'
  | 'proposal_abandoned'
  | (string & {})

/** Event status — `applied` (positive) vs `abandoned` (neutral). */
export type CoachEventStatus = 'applied' | 'abandoned' | (string & {})

export interface CoachHistoryMessage {
  role: ChatMessageRole
  /** Raw text for user/tool turns; empty for assistant turns (see `parts`). */
  content: string
  parts: AssistantPart[]
  name?: string | null
  tool_call_id?: string | null
  /** Stable message identity for dedup / anchoring (e.g. "..#1"). */
  message_id?: string | null
  /** Echoed client_turn_id for assistant turns; null for user/tool. */
  turn_id?: string | null
  created_at?: string | null
  // ── role="event" only (trusted system receipts) ──
  event_type?: CoachEventType | null
  status?: CoachEventStatus | null
  summary?: string | null
  detail?: Record<string, unknown> | null
}

/**
 * GET /api/users/me/coach/sessions/{session_id}/messages.
 * The frontend passes only `session_id`; the thread is derived server-side
 * from the JWT. `debug` is true only for whitelisted debug users, who also
 * receive reasoning / tool_meta parts and role="tool" turns.
 */
export interface SessionHistoryResponse {
  session_id: string
  thread_id: string
  user_id: string
  debug: boolean
  messages: CoachHistoryMessage[]
}

/**
 * Legacy audit endpoint shape (GET /coach/threads/{thread_id}/messages).
 * Retained for reference; the frontend uses the sessions endpoint above.
 */
export interface ThreadHistoryResponse {
  thread_id: string
  user_id: string
  scope: string
  key: string
  messages: CoachHistoryMessage[]
}

// ── Chat turn response (coach.py ChatResponse) ──────────────────────────────

/**
 * A Pattern-Y write proposal riding a chat turn (coach.contracts.turn
 * `ProposalCard`). The inner `proposal` is one of PlanDiff / MasterPlanDiff /
 * WeeklyPlanCreateProposal — opaque at its leaves here; the upgrade card
 * normalizes it into the workspace's `WorkspaceProposal` before stashing.
 */
export type SeasonImpactLevel = 'none' | 'advisory' | 'material'

export interface CoachSeasonImpact {
  level: SeasonImpactLevel
  reasons: string[]
  metrics: Record<string, number>
}

export interface CoachProposalCard {
  specialist_id: string
  summary: string
  /** TargetRef: kind master|week|session with plan_id / folder. */
  target: CoachTargetRef | null
  /** Original PlanDiff / MasterPlanDiff / WeeklyPlanCreateProposal. */
  proposal: Record<string, unknown>
  /** Weekly content fingerprint or stringified Master Plan version. */
  base_revision: string | null
  season_impact: CoachSeasonImpact | null
}

/** coach.contracts.target.TargetRef — which plan surface the turn acts on. */
export interface CoachTargetRef {
  kind: 'master' | 'week' | 'session'
  plan_id?: string | null
  folder?: string | null
  date?: string | null
  session_index?: number | null
}

export interface CoachActiveTarget extends CoachTargetRef {
  [key: string]: unknown
}

/**
 * Stable assistant-turn identity returned by POST /coach/chat. `turn_id`
 * echoes the request's `client_turn_id`; `message_id` is server-assigned.
 * Used for local dedup so a replay (same client_turn_id) never double-appends.
 */
export interface AssistantMessage {
  role: 'assistant'
  message_id: string
  turn_id: string
  created_at: string
  parts: AssistantPart[]
}

export interface ChatResponse {
  session_id: string
  thread_id: string
  /** The user-facing coach answer, GFM markdown. */
  reply: string
  /** Stable assistant-turn identity — always present on a successful turn. */
  assistant_message: AssistantMessage
  clarification?: string | null
  active_target?: CoachActiveTarget | null
  proposals: CoachProposalCard[]
}

// ── View model used by the hook / components ────────────────────────────────

/**
 * `tool` is only produced for debug users (raw role="tool" content); normal
 * users never see it. `event` is a trusted system receipt (plan applied /
 * abandoned) shown to everyone. `user` / `coach` are the everyday bubbles.
 */
export type ChatMessageViewRole = 'user' | 'coach' | 'tool' | 'event'

export interface ChatMessageView {
  role: ChatMessageViewRole
  content: string
  /** Structured assistant parts (debug users render reasoning/tool_meta). */
  parts?: AssistantPart[]
  /** true when the coach turn was a refusal, for styling. */
  refusal?: boolean
  /** Stable server message id (from assistant_message / history). Dedup key. */
  messageId?: string | null
  /** Echoed client_turn_id for assistant turns. */
  turnId?: string | null
  createdAt?: string | null
  /** Name of the tool, for debug tool views. */
  toolName?: string | null
  // ── role="event" only ──
  eventType?: CoachEventType | null
  eventStatus?: CoachEventStatus | null
  eventDetail?: Record<string, unknown> | null
}
