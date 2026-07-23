import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import CoachWeeklyPlanEmptyState from '../components/weekly-plan/CoachWeeklyPlanEmptyState'
import { CoachPlanAppliedBanner } from '../components/CoachPlanAppliedBanner'
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
  const navigate = useNavigate()
  const {
    week,
    weeks,
    planDays,
    strength,
    structuredStatus,
    canPushRun,
    canPushStrength,
    loading,
    error,
    saveFeedback,
    pushSession,
  } = useCoachWeeklyPlan()

  if (loading) return <div className="flex items-center justify-center py-20"><div className="h-6 w-6 animate-spin rounded-full border-2 border-accent-green/30 border-t-accent-green" /></div>
  if (error) return <div role="alert" className="mx-auto mt-10 max-w-xl rounded-xl border border-accent-red/30 bg-red-soft p-4 text-sm text-accent-red">{error}</div>
  if (!week) return <div className="px-4 py-12 sm:px-8"><CoachWeeklyPlanEmptyState /></div>
  if (planDays.every((day) => day.sessions.length === 0) && !week.plan?.trim()) return <div className="px-4 py-12 sm:px-8"><CoachWeeklyPlanEmptyState /></div>

  const planTitle = weeks.find((item) => item.folder === week.folder)?.plan_title

  return (
    <div className="mx-auto max-w-[1180px] space-y-6 px-4 py-6 sm:px-8 sm:py-8">
      <CoachPlanAppliedBanner />
      <WeeklyPlanSummary
        week={week}
        days={planDays}
        planTitle={planTitle}
        onAdjust={() => navigate(`/coach/week/${encodeURIComponent(week.folder)}/adjust`)}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <WeeklyPlanTabs active={activeTab} strengthCount={strength?.sessions.length ?? 0} recordCount={week.activity_count} onChange={setActiveTab} />
      </div>
      <div id="weekly-plan-tabpanel" role="tabpanel" aria-labelledby={`weekly-plan-tab-${activeTab}`} className="animate-fade-in">
        {activeTab === 'schedule' && <WeeklyScheduleTab week={week} days={planDays} structuredStatus={structuredStatus} canPushRun={canPushRun} canPushStrength={canPushStrength} onPush={pushSession} />}
        {activeTab === 'strength' && <WeeklyStrengthTab data={strength} days={planDays} />}
        {activeTab === 'records' && <WeeklyRecordsTab days={planDays} activities={week.activities} />}
        {activeTab === 'feedback' && <WeeklyFeedbackTab initialValue={week.feedback ?? ''} days={planDays} onSave={saveFeedback} />}
      </div>
    </div>
  )
}
