import type { ReactNode } from 'react'
import { WorkspaceLayout } from './WorkspaceLayout'

interface PlanAdjustIntakeWorkspaceProps {
  /** 'weekly' | 'master' — drives the copy. */
  readonly kind: 'weekly' | 'master'
  /** One-line summary of the current target plan (or a loading placeholder). */
  readonly currentPlanSummary: string
  /** Right column chat, already bound to the target + context anchor. */
  readonly chat: ReactNode
  /**
   * True when the target week has no plan yet — invites the user to have the
   * coach create one rather than adjust.
   */
  readonly emptyTarget?: boolean
}

/**
 * The no-stash intake state of the adjust workspace. There is no proposal to
 * review yet, so there is no "启用计划" CTA — the middle column shows the current
 * plan and invites the user to tell the coach what to change; the coach then
 * produces a proposal (which re-enters via the stash + upgrade card).
 */
export function PlanAdjustIntakeWorkspace({
  kind,
  currentPlanSummary,
  chat,
  emptyTarget = false,
}: PlanAdjustIntakeWorkspaceProps) {
  const title = kind === 'weekly' ? '调整本周计划' : '调整赛季计划'
  return (
    <WorkspaceLayout title={title} chat={chat}>
      <section className="space-y-4">
        <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
            {kind === 'weekly' ? '当前计划' : '当前赛季计划'}
          </div>
          <div className="mt-1 text-sm text-text-primary">{currentPlanSummary}</div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-bg-card p-4 text-sm text-text-muted">
          {emptyTarget
            ? '这一周还没有计划。告诉 Coach 你的目标，让它为你生成一份。'
            : '告诉 Coach 你想怎么调整，它会给出一份可启用的调整方案。'}
        </div>
      </section>
    </WorkspaceLayout>
  )
}
