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
import type {
  CreatePlanDay,
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

function toCreatePlanDays(rawPlan: unknown): CreatePlanDay[] {
  if (typeof rawPlan !== 'object' || rawPlan === null) return []
  const sessions = (rawPlan as Record<string, unknown>).sessions
  if (!Array.isArray(sessions)) return []

  return sessions.flatMap((session) => {
    if (typeof session !== 'object' || session === null) return []
    const item = session as Record<string, unknown>
    const label = str(item.date)
    if (!label) return []
    const detail = str(item.summary) ?? str(item.notes_md) ?? str(item.kind) ?? '训练安排'
    return [{ label, detail }]
  })
}

/**
 * Normalize the raw backend proposal (PlanDiff / MasterPlanDiff /
 * WeeklyPlanCreateProposal) into the workspace `WorkspaceProposal` shape.
 * `baseRevision` and `seasonImpact` come from the OUTER card (card.base_revision
 * / card.season_impact), NOT the inner proposal body. Only a `material` impact
 * level produces the blocking `seasonImpact` text; `advisory` is carried as a
 * non-blocking projection. Returns null when the raw card has no recognizable
 * proposal body — the card then behaves as a plain "open workspace" entry.
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
  const isCreate = raw.plan !== undefined || raw.days !== undefined || ops === undefined
  if (isCreate) {
    const opIds = Array.isArray(raw.op_ids)
      ? raw.op_ids.filter((x): x is string => typeof x === 'string')
      : []
    return {
      proposalType: 'weekly_create',
      summary,
      baseRevision,
      opIds,
      days: toCreatePlanDays(raw.plan ?? raw.days),
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

  const hasProposal = Boolean(proposal?.proposal)
  const summary =
    str(proposal?.summary) ?? (resolved.isWeekly ? '本周课表调整方案' : '赛季训练计划调整方案')

  const onSelect = () => {
    const normalized = normalizeProposal(
      resolved.isWeekly,
      proposal?.proposal,
      summary,
      str(proposal?.base_revision) ?? '',
      proposal?.season_impact,
    )
    if (normalized) {
      try {
        stashProposal({
          target: resolved.targetKey,
          contextAnchor,
          proposal: normalized,
          rawProposal: proposal?.proposal ?? {},
        })
      } catch {
        /* sessionStorage unavailable — the workspace can refetch */
      }
    }
    navigate(resolved.path)
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
