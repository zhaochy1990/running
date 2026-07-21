/**
 * CoachProposalUpgradeCard — the escalation entry from chat into the plan
 * adjust workspace.
 *
 * When a coach turn carries a Pattern-Y proposal (or just an active plan
 * target), we show a compact card. Selecting it normalizes the raw backend
 * proposal into the workspace `WorkspaceProposal` shape, stashes it via the
 * shared `stashProposal` (keyed by user + target — never a duplicate store),
 * then navigates to the adjust workspace:
 *   weekly -> /coach/week/:folder/adjust
 *   master -> /coach/master/:planId/adjust
 * The target pages are wired by the main thread; this card owns the handoff.
 */
import { useNavigate } from 'react-router-dom'

import { stashProposal } from '../lib/coachProposalStorage'
import { fingerprintProposal } from './coach-workspace/draftRevision'
import { projectWeeklyCreate } from './coach-workspace/weeklyCreateProjection'
import type {
  DiffChange,
  ProposalTargetKey,
  WorkspaceProposal,
} from './coach-workspace/types'
import type { CoachActiveTarget, CoachProposalCard, CoachSeasonImpact, CoachTargetRef } from '../types/coachChat'

export interface CoachProposalUpgradeCardProps {
  userId: string
  proposal?: CoachProposalCard
  activeTarget?: CoachActiveTarget | null
  /** Chat message id the workspace conversation should resume from. */
  contextAnchor?: string
}

interface Resolved {
  targetKey: ProposalTargetKey
  path: string
  isWeekly: boolean
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** Resolve the plan surface from the raw proposal / active target. */
function resolveTarget(
  userId: string,
  proposal: CoachProposalCard | undefined,
  activeTarget: CoachActiveTarget | null | undefined,
): Resolved | null {
  const ref: CoachTargetRef | undefined =
    (proposal?.target as CoachTargetRef | undefined) ?? activeTarget ?? undefined
  const rawProposal = proposal?.proposal ?? {}

  const planId = str(ref?.plan_id) ?? str(rawProposal.plan_id as unknown)
  const folder = str(ref?.folder) ?? str(rawProposal.folder as unknown)
  const isMaster = ref?.kind === 'master' || (!!planId && !folder)

  if (isMaster) {
    if (!planId) return null
    return {
      targetKey: { userId, kind: 'master', planId },
      path: `/coach/master/${encodeURIComponent(planId)}/adjust`,
      isWeekly: false,
    }
  }
  if (!folder) return null
  return {
    targetKey: { userId, kind: 'weekly', folder },
    path: `/coach/week/${encodeURIComponent(folder)}/adjust`,
    isWeekly: true,
  }
}

function summarizeValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    const summary = (value as Record<string, unknown>).summary
    if (typeof summary === 'string') return summary
    try {
      return JSON.stringify(value)
    } catch {
      return null
    }
  }
  return String(value)
}

/** Map raw diff ops into the workspace `DiffChange[]` (best-effort, defensive). */
function toDiffChanges(ops: unknown): DiffChange[] {
  if (!Array.isArray(ops)) return []
  return ops.map((op, i) => {
    const o = (op ?? {}) as Record<string, unknown>
    const changeTypeRaw = str(o.op) ?? str(o.kind) ?? 'update'
    const changeType: DiffChange['changeType'] = changeTypeRaw.includes('add')
      ? 'add'
      : changeTypeRaw.includes('remove')
        ? 'remove'
        : 'update'
    return {
      opId: str(o.id) ?? `op-${i}`,
      label: str(o.label) ?? str(o.op) ?? str(o.kind) ?? `变更 ${i + 1}`,
      changeType,
      oldValue: summarizeValue(o.old_value),
      newValue: summarizeValue(o.new_value),
    }
  })
}

/**
 * Normalize the raw backend proposal (PlanDiff / MasterPlanDiff /
 * WeeklyPlanCreateProposal) into the workspace `WorkspaceProposal` shape.
 * `baseRevision` comes from the OUTER card but must match the revision pinned
 * inside the raw proposal. This prevents a restored or tampered card from
 * rebinding an old diff to a newer plan snapshot. `seasonImpact` remains outer
 * adapter metadata. Returns null when the body is malformed or revisions differ.
 */
function normalizeProposal(
  isWeekly: boolean,
  raw: Record<string, unknown> | undefined,
  summary: string,
  baseRevision: string,
  seasonImpact: CoachSeasonImpact | null | undefined,
): WorkspaceProposal | null {
  if (!raw) return null
  const ops = raw.ops
  const rawRevision = str(raw.base_revision)
  const isCreate = isWeekly && (raw.plan !== undefined || raw.days !== undefined || ops === undefined)
  const revisionsMatch = isCreate
    ? (rawRevision ?? '') === baseRevision
    : Boolean(baseRevision) && rawRevision === baseRevision
  if (!revisionsMatch) return null

  if (!isWeekly) {
    return {
      proposalType: 'master_diff',
      summary,
      baseRevision,
      changes: toDiffChanges(ops),
    }
  }
  // Weekly: a create proposal carries a full plan (no diff ops); otherwise it
  // is a weekly diff.
  if (isCreate) {
    const opIds = Array.isArray(raw.op_ids)
      ? raw.op_ids.filter((x): x is string => typeof x === 'string')
      : []
    const { days, strength, nutrition, notesMd } = projectWeeklyCreate(raw.plan ?? raw.days ?? raw)
    // A full create proposal must contain a reviewable calendar. Never replace
    // the current Review with an intermediate "remove everything" marker.
    if (days.length === 0) return null
    return {
      proposalType: 'weekly_create',
      summary,
      baseRevision,
      opIds,
      days,
      strength,
      nutrition,
      notesMd,
    }
  }
  const isMaterial = seasonImpact?.level === 'material'
  return {
    proposalType: 'weekly_diff',
    summary,
    baseRevision,
    changes: toDiffChanges(ops),
    // Only material impact gates apply.
    seasonImpact: isMaterial ? seasonImpact.reasons.join('；') || '该调整明显偏离赛季计划' : null,
    seasonImpactProjection: seasonImpact
      ? { level: seasonImpact.level, reasons: seasonImpact.reasons }
      : null,
  }
}

export default function CoachProposalUpgradeCard({
  userId,
  proposal,
  activeTarget,
  contextAnchor = '',
}: CoachProposalUpgradeCardProps) {
  const navigate = useNavigate()
  const resolved = resolveTarget(userId, proposal, activeTarget)
  if (!resolved) return null

  const summary =
    str(proposal?.summary) ?? (resolved.isWeekly ? '本周课表调整方案' : '赛季训练计划调整方案')
  const rawProposalBody = proposal?.proposal
  const normalized = normalizeProposal(
    resolved.isWeekly,
    rawProposalBody,
    summary,
    str(proposal?.base_revision) ?? '',
    proposal?.season_impact,
  )
  // Malformed or empty proposal bodies are not actionable. The Coach reply
  // remains visible, but no card can wipe the current Review.
  if (rawProposalBody && !normalized) return null
  const hasProposal = normalized !== null

  const onSelect = () => {
    if (normalized) {
      try {
        stashProposal({
          target: resolved.targetKey,
          contextAnchor,
          proposal: normalized,
          rawProposal: rawProposalBody ?? {},
        })
      } catch {
        /* sessionStorage unavailable — the workspace can refetch */
      }
    }
    // For a weekly-create proposal, carry a stable content fingerprint as the
    // draftRevision navigation state so WeeklyPlanAdjustPage can re-read the
    // stash when this card is selected again with a revised draft (task #30).
    // Weekly-diff and master proposals keep the existing no-state contract.
    const navState =
      resolved.isWeekly && normalized?.proposalType === 'weekly_create' && rawProposalBody
        ? { state: { draftRevision: fingerprintProposal(rawProposalBody) } }
        : undefined
    if (navState) {
      navigate(resolved.path, navState)
    } else {
      navigate(resolved.path)
    }
  }

  return (
    <div className="rounded-lg border border-accent-green/30 bg-accent-green/5 px-3.5 py-3">
      <p className="text-xs font-mono uppercase tracking-wide text-accent-green/80">
        {resolved.isWeekly ? '本周课表' : '赛季训练计划'}
      </p>
      <p className="mt-1 text-sm text-text-primary">{summary}</p>
      <button
        type="button"
        onClick={onSelect}
        className="mt-2.5 rounded-md bg-accent-green-dim px-3 py-1.5 text-sm font-medium text-black transition-colors hover:bg-accent-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-green"
      >
        {hasProposal ? '查看调整方案' : '打开计划审阅工作区'}
      </button>
    </div>
  )
}
