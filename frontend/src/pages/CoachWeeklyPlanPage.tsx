import { useState } from 'react'
import CoachWeeklyPlanEmptyState from '../components/weekly-plan/CoachWeeklyPlanEmptyState'
import WeeklyFeedbackTab from '../components/weekly-plan/WeeklyFeedbackTab'
import WeeklyPlanSummary from '../components/weekly-plan/WeeklyPlanSummary'
import WeeklyPlanTabs, { type CoachWeeklyPlanTab } from '../components/weekly-plan/WeeklyPlanTabs'
import WeeklyRecordsTab from '../components/weekly-plan/WeeklyRecordsTab'
import WeeklyScheduleTab from '../components/weekly-plan/WeeklyScheduleTab'
import WeeklyStrengthTab from '../components/weekly-plan/WeeklyStrengthTab'
import { useCoachWeeklyPlan } from '../hooks/useCoachWeeklyPlan'

export interface CoachWeeklyPlanPageProps {
  readonly initialTab?: CoachWeeklyPlanTab
}

export default function CoachWeeklyPlanPage({ initialTab = 'schedule' }: CoachWeeklyPlanPageProps) {
  const [activeTab, setActiveTab] = useState<CoachWeeklyPlanTab>(initialTab)
  const { week, planDays, strength, loading, error, saveFeedback } = useCoachWeeklyPlan()

  if (loading) return <div className="flex items-center justify-center py-20"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent-green/30 border-t-accent-green" /></div>
  if (error) return <div role="alert" className="mx-auto mt-10 max-w-xl rounded-xl border border-accent-red/30 bg-red-soft p-4 text-sm text-accent-red">{error}</div>
  if (!week) return <div className="px-4 py-12 sm:px-8"><CoachWeeklyPlanEmptyState /></div>

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
      <WeeklyPlanSummary week={week} />
      <WeeklyPlanTabs active={activeTab} strengthCount={strength?.sessions.length ?? 0} recordCount={week.activity_count} onChange={setActiveTab} />
      <div className="animate-fade-in">
        {activeTab === 'schedule' && <WeeklyScheduleTab week={week} days={planDays} />}
        {activeTab === 'strength' && <WeeklyStrengthTab data={strength} />}
        {activeTab === 'records' && <WeeklyRecordsTab activities={week.activities} />}
        {activeTab === 'feedback' && <WeeklyFeedbackTab initialValue={week.feedback ?? ''} onSave={saveFeedback} />}
      </div>
    </div>
  )
}
