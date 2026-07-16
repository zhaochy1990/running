import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getPlanDays,
  getMyProfile,
  getWeek,
  getWeeks,
  getWeekStrength,
  pushPlannedSession,
  updateWeeklyFeedback,
  type PlanDay,
  type WeekDetail,
  type WeekSummary,
} from '../api'
import type { PlannedSession, StructuredStatus } from '../types/plan'
import type { StrengthTabResponse } from '../types/strength'
import { useUser } from '../UserContextValue'
import { shanghaiToday } from '../lib/shanghai'
import { findCurrentWeek } from '../lib/weeklyPlanView'

export interface CoachWeeklyPlanState {
  readonly week: WeekDetail | null
  readonly weeks: readonly WeekSummary[]
  readonly planDays: readonly PlanDay[]
  readonly strength: StrengthTabResponse | null
  readonly structuredStatus: StructuredStatus
  readonly canPushRun: boolean
  readonly canPushStrength: boolean
  readonly loading: boolean
  readonly error: string | null
  readonly saveFeedback: (content: string) => Promise<void>
  readonly pushSession: (session: PlannedSession, targetDate?: string) => Promise<void>
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
  const [structuredStatus, setStructuredStatus] = useState<StructuredStatus>('none')
  const [provider, setProvider] = useState('coros')
  const [loadedFolder, setLoadedFolder] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getMyProfile()
      .then((profile) => { if (!cancelled) setProvider(profile.provider ?? 'coros') })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!user) return
    let cancelled = false
    getWeeks(user)
      .then((response) => {
        if (cancelled) return
        setWeeks(response.weeks)
        setWeeksLoaded(true)
        const currentWeek = findCurrentWeek(response.weeks, shanghaiToday())
        if (!folder && currentWeek) {
          navigate(`/week/${currentWeek.folder}`, { replace: true })
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
        setStructuredStatus(weekResponse.structured?.structured_status ?? 'none')
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

  const pushSession = useCallback(async (session: PlannedSession, targetDate?: string) => {
    if (!user || !week) return
    const response = await pushPlannedSession(
      user,
      session.date,
      session.session_index,
      targetDate,
    )
    if (!response.ok) {
      const detail = response.data?.detail
      const message = typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object' && 'error' in detail
          ? String(detail.error ?? '推送失败')
          : `推送失败 (${response.status})`
      throw new Error(message)
    }
    const refreshed = await getPlanDays(user, week.date_from, week.date_to)
    setPlanDays(refreshed.days)
  }, [user, week])

  const loading = folder ? loadedFolder !== folder && error === null : !weeksLoaded && error === null
  return {
    week,
    weeks,
    planDays,
    strength,
    structuredStatus,
    canPushRun: true,
    canPushStrength: provider === 'coros',
    loading,
    error,
    saveFeedback,
    pushSession,
  }
}
