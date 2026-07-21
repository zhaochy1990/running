/**
 * Public contract for the plan-adjust workspace slice.
 *
 * This slice deliberately does NOT depend on the real coach API JSON types
 * (which are still landing in `api.ts`). Instead it defines the minimal shapes
 * the three-column workspace needs, and accepts the heavy lifting — loading the
 * current plan, applying a proposal, navigating — via injected callbacks. The
 * main thread wires a thin adapter from the real API to these props later.
 *
 * External JSON is never `any`. The stashed proposal card is `unknown`-shaped
 * at its leaves and must be narrowed before use.
 */

// ── Target identity ─────────────────────────────────────────────────────────

/** Which plan surface a proposal targets. */
export type PlanTargetKind = 'weekly' | 'master'

/**
 * The key a stashed proposal is filed under, so a proposal generated for one
 * (user, target) pair can never be applied against a different plan.
 */
export interface ProposalTargetKey {
  readonly userId: string
  readonly kind: PlanTargetKind
  /** Weekly folder slug, e.g. `2026-07-13_07-19`. Present when kind==='weekly'. */
  readonly folder?: string
  /** Master plan id. Present when kind==='master'. */
  readonly planId?: string
}

// ── Proposal shapes ─────────────────────────────────────────────────────────

/** Mirrors coach.contracts.season_impact.SeasonImpact.level. */
export type SeasonImpactLevel = 'none' | 'advisory' | 'material'

/**
 * Structured season-impact projection carried on a proposal. `material` blocks
 * apply until acknowledged; `advisory` renders a non-blocking notice.
 */
export interface SeasonImpactProjection {
  readonly level: SeasonImpactLevel
  readonly reasons: readonly string[]
}

/** A single field change inside a diff. */
export interface DiffChange {
  readonly opId: string
  /** Human label for the changed field, e.g. "周三 · 配速目标". */
  readonly label: string
  /** 'add' | 'update' | 'remove'. */
  readonly changeType: 'add' | 'update' | 'remove'
  readonly oldValue?: string | null
  readonly newValue?: string | null
}

/**
 * A weekly plan-diff proposal — adjust an existing week. `seasonImpact` is set
 * when the change ripples into the wider season; the workspace then forces an
 * explicit acknowledgement before apply is allowed.
 */
export interface WeeklyDiffProposal {
  readonly proposalType: 'weekly_diff'
  readonly summary: string
  readonly baseRevision: string
  readonly changes: readonly DiffChange[]
  /**
   * Blocking impact text — set ONLY when the projected impact level is
   * `material`. Its presence gates apply behind an explicit "weekly only"
   * acknowledgement. Advisory-level impact must NOT populate this.
   */
  readonly seasonImpact?: string | null
  /** Full structured projection (level + reasons), for advisory notices. */
  readonly seasonImpactProjection?: SeasonImpactProjection | null
}

/** A single created-plan day, for the create Review. */
export interface CreatePlanDay {
  readonly label: string
  readonly detail: string
}

/** One strength exercise projected from a canonical `StrengthExerciseSpec`. */
export interface CreatePlanStrengthExercise {
  readonly name: string
  /** Number of sets, when known. */
  readonly sets?: number | null
  /**
   * Human target string — reps (`12 次`) or duration (`45 秒`) — pre-formatted
   * from `target_kind` + `target_value`. Null when the raw spec is unusable.
   */
  readonly target?: string | null
  /** Rest between sets, formatted (`休息 60 秒`). Null when absent. */
  readonly rest?: string | null
  readonly note?: string | null
}

/** One strength day, for the standalone strength section of the create Review. */
export interface CreatePlanStrengthDay {
  /** ISO date label (`2026-07-20`). */
  readonly label: string
  /** Workout title, when the raw spec named it. */
  readonly title?: string | null
  readonly exercises: readonly CreatePlanStrengthExercise[]
  readonly note?: string | null
}

/** One meal within a nutrition day. */
export interface CreatePlanMeal {
  readonly name: string
  readonly timeHint?: string | null
  readonly kcal?: number | null
  readonly carbsG?: number | null
  readonly proteinG?: number | null
  readonly fatG?: number | null
  readonly itemsMd?: string | null
}

/** One nutrition day, for the standalone nutrition section of the create Review. */
export interface CreatePlanNutritionDay {
  /** ISO date label (`2026-07-20`). */
  readonly label: string
  readonly kcalTarget?: number | null
  readonly carbsG?: number | null
  readonly proteinG?: number | null
  readonly fatG?: number | null
  readonly waterMl?: number | null
  readonly meals: readonly CreatePlanMeal[]
  readonly notesMd?: string | null
}

/**
 * A weekly plan-create proposal — a brand new week. Rendered as a full creation
 * Review (no diff old/new columns).
 *
 * The raw proposal carries a canonical `WeeklyPlan` (sessions + nutrition +
 * top-level notes). This projection splits it into the three surfaces the
 * Review renders: the training calendar (`days`), the standalone strength
 * section (`strength`), and the standalone nutrition section (`nutrition`).
 * `notesMd` is the plan-level weekly note (safe Markdown, no raw HTML).
 */
export interface WeeklyCreateProposal {
  readonly proposalType: 'weekly_create'
  readonly summary: string
  readonly baseRevision: string
  readonly opIds: readonly string[]
  readonly days: readonly CreatePlanDay[]
  readonly strength: readonly CreatePlanStrengthDay[]
  readonly nutrition: readonly CreatePlanNutritionDay[]
  readonly notesMd?: string | null
}

/** A master plan diff proposal — adjust the season plan. */
export interface MasterDiffProposal {
  readonly proposalType: 'master_diff'
  readonly summary: string
  readonly baseRevision: string
  readonly changes: readonly DiffChange[]
}

export type WeeklyProposal = WeeklyDiffProposal | WeeklyCreateProposal
export type WorkspaceProposal = WeeklyProposal | MasterDiffProposal

/**
 * The full envelope stashed in sessionStorage: the proposal plus the context
 * anchor (the chat message id the conversation should resume from) and the
 * target key it was generated against.
 */
export interface StashedProposal<P extends WorkspaceProposal = WorkspaceProposal> {
  readonly target: ProposalTargetKey
  readonly contextAnchor: string
  /** User-facing projection rendered by the Review workspace. */
  readonly proposal: P
  /** Original PlanDiff / MasterPlanDiff / WeeklyPlanCreateProposal for apply. */
  readonly rawProposal: Readonly<Record<string, unknown>>
}

// ── Apply request / response ────────────────────────────────────────────────

export interface ApplyProposalRequest {
  readonly opIds: readonly string[]
  readonly baseRevision: string
  /** Present only when a material season impact was acknowledged. */
  readonly impactAcknowledgement?: string
}

export type ApplyOutcome =
  | { readonly status: 'ok' }
  /** 409 — the underlying plan moved since the proposal was generated. */
  | { readonly status: 'stale' }
  /**
   * 409 season_impact_material — the server requires an explicit weekly-only
   * acknowledgement before applying. Not an error; the workspace switches to
   * the confirmation gate rather than the stale state.
   */
  | { readonly status: 'needs_ack'; readonly seasonImpact: string }
  | { readonly status: 'error'; readonly message: string }
