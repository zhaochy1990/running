export type CoachWeeklyPlanTab = 'schedule' | 'strength' | 'records' | 'feedback'

export interface WeeklyPlanTabsProps {
  readonly active: CoachWeeklyPlanTab
  readonly strengthCount: number
  readonly recordCount: number
  readonly onChange: (tab: CoachWeeklyPlanTab) => void
}

const tabs: ReadonlyArray<{ id: CoachWeeklyPlanTab; label: string }> = [
  { id: 'schedule', label: '本周训练课表' },
  { id: 'strength', label: '本周力量训练' },
  { id: 'records', label: '本周训练记录' },
  { id: 'feedback', label: '本周反馈' },
]

export default function WeeklyPlanTabs({ active, strengthCount, recordCount, onChange }: WeeklyPlanTabsProps) {
  return (
    <div className="flex gap-6 overflow-x-auto border-b border-border-subtle" role="tablist" aria-label="本周计划视图">
      {tabs.map((tab) => {
        const count = tab.id === 'strength' ? strengthCount : tab.id === 'records' ? recordCount : null
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => onChange(tab.id)}
            className={`pb-3 text-sm whitespace-nowrap transition-colors ${active === tab.id ? 'font-bold text-accent-green border-b-2 border-accent-green' : 'font-medium text-text-muted hover:text-text-primary'}`}
          >
            {tab.label}
            {count !== null && <span className="ml-1.5 rounded-full bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">{count}</span>}
          </button>
        )
      })}
    </div>
  )
}
