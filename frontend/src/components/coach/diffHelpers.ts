// Shared helpers for rendering + applying coach proposal diffs.
// A proposal carries either a week PlanDiff (target.kind week/session) or a
// season MasterPlanDiff (target.kind master); both op shapes expose
// `id / op / old_value / new_value`, so the UI can treat them uniformly.

import {
  applyCoachMasterDiff,
  applyCoachWeekDiff,
  isWeekDiff,
  type CoachProposalCard,
  type MasterPlanDiffOp,
  type WeekDiffOp,
} from '../../api'

/** The union of week + master diff ops — the fields the UI actually renders. */
export type AnyDiffOp = WeekDiffOp | MasterPlanDiffOp

const OP_LABELS: Record<string, string> = {
  // week (stride_core.plan_diff.DiffOpKind)
  move_session: '移动课次',
  replace_kind: '改课型',
  replace_distance: '改距离 / 时长',
  add_session: '新增课次',
  remove_session: '删除课次',
  replace_note: '改备注',
  // master (stride_core.master_plan_diff)
  add_phase: '新增阶段',
  remove_phase: '删除阶段',
  resize_phase: '调整阶段日期',
  replace_phase_focus: '调整阶段重点',
  replace_weekly_range: '调整周量区间',
  add_milestone: '新增里程碑',
  remove_milestone: '删除里程碑',
  replace_milestone_date: '调整里程碑日期',
  replace_milestone_target: '调整里程碑目标',
}

export function opLabel(op: string): string {
  return OP_LABELS[op] ?? op
}

/** Tailwind class for the op-kind mono pill (soft fill + edge), phase-coded. */
export function opPillClass(op: string): string {
  if (op.startsWith('move') || op.startsWith('add')) {
    return 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30'
  }
  if (op.startsWith('remove')) {
    return 'bg-accent-red/10 text-accent-red border-accent-red/30'
  }
  if (op.includes('distance') || op.includes('range') || op.includes('resize')) {
    return 'bg-accent-amber/10 text-accent-amber border-accent-amber/30'
  }
  return 'bg-accent-purple/10 text-accent-purple border-accent-purple/30'
}

function renderValue(value: Record<string, unknown> | null): string {
  if (value == null) return '—'
  // Prefer common human-readable keys before falling back to compact JSON.
  const preferred = ['summary', 'text', 'label', 'kind', 'focus', 'target']
  for (const key of preferred) {
    const v = value[key]
    if (typeof v === 'string' && v.trim()) return v
  }
  const entries = Object.entries(value).filter(([, v]) => v != null)
  if (entries.length === 0) return '—'
  return entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')
}

export function summarizeOld(op: AnyDiffOp): string {
  return renderValue(op.old_value)
}

export function summarizeNew(op: AnyDiffOp): string {
  return renderValue(op.new_value)
}

/** One-line before→after summary for compact rows. */
export function summarizeOp(op: AnyDiffOp): string {
  return `${summarizeOld(op)} → ${summarizeNew(op)}`
}

/** Where the proposal lands, for the context dock / review header. */
export function proposalTargetLabel(card: CoachProposalCard): string {
  if (isWeekDiff(card.proposal)) return `周计划 · ${card.proposal.folder}`
  return `赛季计划 · ${card.proposal.plan_id}`
}

export interface ApplyOutcome {
  ok: boolean
  status: number
  applied: number
  detail: string
}

/**
 * Dispatch a Pattern-Y apply to the matching stateless endpoint by diff shape,
 * sending the whole diff back with the accepted op ids. Folder / plan_id come
 * from the diff itself (authoritative), with the target as a fallback.
 */
export async function applyProposal(
  card: CoachProposalCard,
  acceptedOpIds: string[],
): Promise<ApplyOutcome> {
  const diff = card.proposal
  if (isWeekDiff(diff)) {
    const folder = diff.folder || card.target?.folder || ''
    const res = await applyCoachWeekDiff(folder, diff, acceptedOpIds)
    return {
      ok: res.ok,
      status: res.status,
      applied: res.data?.applied ?? 0,
      detail: res.ok ? `已应用 ${res.data.applied} 项到 ${res.data.folder}` : '应用失败',
    }
  }
  const planId = diff.plan_id || card.target?.plan_id || ''
  const res = await applyCoachMasterDiff(planId, diff, acceptedOpIds)
  return {
    ok: res.ok,
    status: res.status,
    applied: res.data?.applied ?? 0,
    detail: res.ok ? `已应用 ${res.data.applied} 项 · 计划版本 v${res.data.version}` : '应用失败',
  }
}
