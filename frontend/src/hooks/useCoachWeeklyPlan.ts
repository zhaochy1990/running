import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getPlanDays,
  getWeek,
  getWeeks,
  getWeekStrength,
  updateWeeklyFeedback,
  type PlanDay,
  type WeekDetail,
  type WeekSummary,
} from '../api'
import type { StrengthTabResponse } from '../types/strength'
import { useUser } from '../UserContextValue'

export interface CoachWeeklyPlanState {
  readonly week: WeekDetail | null
  readonly weeks: readonly WeekSummary[]
  readonly planDays: readonly PlanDay[]
  readonly strength: StrengthTabResponse | null
  readonly loading: boolean
  readonly error: string | null
  readonly saveFeedback: (content: string) => Promise<void>
}

export function useCoachWeeklyPlan(): CoachWeeklyPlanState {
  const { folder } = useParams<{ folder: string }>()
  const navigate = useNavigate()
  const { user } = useUser()
  const [weeks, setWeeks] = useState<WeekSummary[]>([])
  const [weeksLoaded, setWeeksLoaded] = useState(false)
  const [week, setWeek] = useState<WeekDetail | null>(null)
  const [planDays, setPlanDays] = useState<PlanDay[]>([])
  const [strength, setStrength] = useState<StrengthTabResponse | null>(null)
  const [loadedFolder, setLoadedFolder] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    getWeeks(user)
      .then((response) => {
        if (cancelled) return
        setWeeks(response.weeks)
        setWeeksLoaded(true)
        if (!folder && response.weeks[0]) {
          navigate(`/week/${response.weeks[0].folder}`, { replace: true })
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setWeeksLoaded(true)
          setError(reason instanceof Error ? reason.message : '无法加载训练周')
        }
      })
    return () => { cancelled = true }
  }, [folder, navigate, user])

  useEffect(() => {
    if (!folder || !user) return
    let cancelled = false
    Promise.all([
      getWeek(user, folder),
      getWeekStrength(user, folder).catch(() => null),
    ])
      .then(async ([weekResponse, strengthResponse]) => {
        if (cancelled) return
        setWeek(weekResponse)
        setStrength(strengthResponse)
        const days = await getPlanDays(user, weekResponse.date_from, weekResponse.date_to)
        if (!cancelled) setPlanDays(days.days)
        if (!cancelled) {
          setLoadedFolder(folder)
          setError(null)
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '无法加载本周计划')
      })
    return () => { cancelled = true }
  }, [folder, user])

  const saveFeedback = useCallback(async (content: string) => {
    if (!folder || !user) return
    await updateWeeklyFeedback(user, folder, content)
    setWeek((current) => current ? { ...current, feedback: content, feedback_source: 'db' } : current)
  }, [folder, user])

  const loading = folder ? loadedFolder !== folder && error === null : !weeksLoaded && error === null
  return { week, weeks, planDays, strength, loading, error, saveFeedback }
}
