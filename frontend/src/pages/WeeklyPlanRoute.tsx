import { useUser } from '../UserContextValue'
import CoachWeeklyPlanPage from './CoachWeeklyPlanPage'
import WeekLayout from './WeekLayout'

export interface WeeklyPlanRouteProps {
  readonly forceCoachAgent?: boolean
}

export default function WeeklyPlanRoute({ forceCoachAgent = false }: WeeklyPlanRouteProps) {
  const { coachAgentWeeklyPlan, profileReady } = useUser()

  if (!profileReady) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return forceCoachAgent || coachAgentWeeklyPlan ? <CoachWeeklyPlanPage /> : <WeekLayout />
}
