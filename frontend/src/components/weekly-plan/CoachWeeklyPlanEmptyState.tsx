export interface CoachWeeklyPlanEmptyStateProps {
  readonly detail?: string
}

export default function CoachWeeklyPlanEmptyState({
  detail = 'Coach 会结合你的赛季目标、近期训练和恢复状态，为你生成适合本周执行的训练计划。',
}: CoachWeeklyPlanEmptyStateProps) {
  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-green-edge bg-bg-card px-6 py-16 text-center shadow-sm">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-soft text-xl text-accent-green" aria-hidden="true">
        ✦
      </div>
      <p className="mt-5 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-accent-green">Coach Agent · Weekly Plan</p>
      <h1 className="mt-2 text-2xl font-bold text-text-primary">使用 Coach Agent 生成本周计划</h1>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-text-secondary">{detail}</p>
    </section>
  )
}
