import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createRunningProfile,
  createTrainingGoal,
  extractMasterPlanIntake,
  generateMasterPlan,
  getFullSyncStatus,
  getMasterPlanIntake,
  getMasterPlanJob,
  postFullSync,
  type RaceDistance,
  type CurrentWeeklyKm,
  type MasterPlanIntakeContext,
  type MasterPlanIntakeExtractFields,
  type MasterPlanIntakeHistory,
  type MasterPlanIntakePb,
  type MasterPlanIntakeRaceEffort,
  type RunningAge,
  type RunningPbDistance,
  type WeeklyTrainingDays,
  type MasterPlanJob,
  type MasterPlanJobStage,
  type SyncStatus,
} from '../api'

type SetupPhase = 'goals' | 'syncing' | 'generating' | 'ready'
type IntakeField =
  | 'raceDistance'
  | 'raceName'
  | 'raceDate'
  | 'weeklyDays'
  | 'targetTime'
  | 'runningAge'
  | 'currentWeeklyKm'
  | 'pb'
  | 'injuries'

const POLL_INTERVAL_MS = 1500
const MAX_POLL_ATTEMPTS = 400 // 400 * 1.5s = 10 min
const MAX_SYNC_POLL_ATTEMPTS = 900 // 900 * 1.5s = 22.5 min

const DISTANCE_OPTIONS: { value: RaceDistance; label: string }[] = [
  { value: '5K', label: '5K' },
  { value: '10K', label: '10K' },
  { value: 'HM', label: '半马' },
  { value: 'FM', label: '全马' },
  { value: 'trail', label: '越野' },
]

const WEEKLY_DAY_OPTIONS: WeeklyTrainingDays[] = [3, 4, 5, 6]
const RUNNING_AGE_OPTIONS: { value: RunningAge; label: string }[] = [
  { value: 'lt_6m', label: '<6月' },
  { value: '6m_1y', label: '6-12月' },
  { value: '1y_3y', label: '1-3年' },
  { value: '3y_plus', label: '3年以上' },
]
const WEEKLY_KM_OPTIONS: { value: CurrentWeeklyKm; label: string }[] = [
  { value: 'lt_20', label: '<20km' },
  { value: '20_40', label: '20-40km' },
  { value: '40_60', label: '40-60km' },
  { value: '60_plus', label: '60km+' },
]
const PB_OPTIONS: { value: RunningPbDistance; label: string }[] = [
  { value: '5K', label: '5K' },
  { value: '10K', label: '10K' },
  { value: 'HM', label: '半马' },
  { value: 'FM', label: '全马' },
]

// 5-step vertical stepper, driven by the job `stage`. The 5th step ("完成")
// is reached when the job is done.
const GEN_STEPS: { title: string; hint?: string; stages: MasterPlanJobStage[] }[] = [
  { title: '读取训练历史', hint: '活动 · GPS 轨迹', stages: ['reading_history'] },
  { title: '评估当前体能', hint: 'CTL / ATL / form', stages: ['evaluating'] },
  { title: '规划周期阶段', hint: 'base → build → peak → taper', stages: ['planning_phases'] },
  { title: '校验安全规则', hint: '周量爬升 · 长距占比 · 峰值长跑', stages: ['rule_filter', 'outputting'] },
  { title: '完成', stages: [] },
]

interface Props {
  onDraftReady: (planId: string) => void
}

export default function TrainingPlanSetup({ onDraftReady }: Props) {
  const [phase, setPhase] = useState<SetupPhase>('goals')

  // ── Goal form state ──────────────────────────────────────────────────────
  const [raceDistance, setRaceDistance] = useState<RaceDistance | ''>('')
  const [raceName, setRaceName] = useState('')
  const [raceDate, setRaceDate] = useState('')
  const [weeklyDays, setWeeklyDays] = useState<WeeklyTrainingDays | ''>('')
  const [finishOnly, setFinishOnly] = useState(false)
  const [targetTime, setTargetTime] = useState('')
  const [runningAge, setRunningAge] = useState<RunningAge>('1y_3y')
  const [currentWeeklyKm, setCurrentWeeklyKm] = useState<CurrentWeeklyKm>('40_60')
  const [pbDistance, setPbDistance] = useState<RunningPbDistance>('FM')
  const [pbTime, setPbTime] = useState('')
  const [injuryFree, setInjuryFree] = useState(true)
  const [injuryText, setInjuryText] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [intakeMessage, setIntakeMessage] = useState('')
  const [intakeContext, setIntakeContext] = useState<MasterPlanIntakeContext | null>(null)
  const [intakeLoading, setIntakeLoading] = useState(true)
  const [intakeExtracting, setIntakeExtracting] = useState(false)
  const [intakeNotice, setIntakeNotice] = useState<string | null>(null)

  // ── Generating state ─────────────────────────────────────────────────────
  const [goalId, setGoalId] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<MasterPlanJob | null>(null)
  const [draftPlanId, setDraftPlanId] = useState<string | null>(null)
  const syncAttemptRef = useRef(0)
  const pollAttemptRef = useRef(0)
  const handledSyncDoneRef = useRef(false)
  const handledDoneRef = useRef(false)
  const mountedRef = useRef(true)
  const formRevisionRef = useRef(0)
  const dirtyIntakeFieldsRef = useRef(new Set<IntakeField>())

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let cancelled = false
    setIntakeLoading(true)
    getMasterPlanIntake()
      .then((data) => {
        if (cancelled || !mountedRef.current) return
        setIntakeContext(data)
        applyStoredIntake(data)
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setIntakeContext(null)
      })
      .finally(() => {
        if (!cancelled && mountedRef.current) setIntakeLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const markFormEdited = (...fields: IntakeField[]) => {
    formRevisionRef.current += 1
    for (const field of fields) dirtyIntakeFieldsRef.current.add(field)
  }

  const applyStoredIntake = (data: MasterPlanIntakeContext) => {
    const goal = data.goal
    if (goal) {
      if (!dirtyIntakeFieldsRef.current.has('raceDistance')) setRaceDistance(goal.race_distance ?? '')
      if (!dirtyIntakeFieldsRef.current.has('raceName')) setRaceName(goal.race_name ?? '')
      if (!dirtyIntakeFieldsRef.current.has('raceDate')) setRaceDate(goal.race_date ?? '')
      if (!dirtyIntakeFieldsRef.current.has('weeklyDays')) setWeeklyDays(goal.weekly_training_days ?? '')
      if (!dirtyIntakeFieldsRef.current.has('targetTime')) {
        setFinishOnly(!goal.target_finish_time)
        setTargetTime(goal.target_finish_time ?? '')
      }
    }
    const profile = data.profile
    if (profile) {
      if (!dirtyIntakeFieldsRef.current.has('runningAge')) setRunningAge(profile.running_age)
      if (!dirtyIntakeFieldsRef.current.has('currentWeeklyKm')) setCurrentWeeklyKm(profile.current_weekly_km)
      const firstPb = profile.pbs?.[0]
      if (firstPb && !dirtyIntakeFieldsRef.current.has('pb')) {
        setPbDistance(firstPb.distance)
        setPbTime(firstPb.time)
      }
      if (!dirtyIntakeFieldsRef.current.has('injuries')) {
        const injuries = profile.injuries ?? []
        const hasInjuries = injuries.length > 0 && !injuries.includes('none')
        setInjuryFree(!hasInjuries)
        setInjuryText(hasInjuries ? injuries.join('，') : '')
      }
    }
  }

  const applyExtractedFields = (fields: MasterPlanIntakeExtractFields) => {
    const touched: IntakeField[] = []
    if (fields.race_distance) {
      touched.push('raceDistance')
      setRaceDistance(fields.race_distance)
    }
    if (fields.race_name) {
      touched.push('raceName')
      setRaceName(fields.race_name)
    }
    if (fields.race_date) {
      touched.push('raceDate')
      setRaceDate(fields.race_date)
    }
    if (fields.weekly_training_days) {
      touched.push('weeklyDays')
      setWeeklyDays(fields.weekly_training_days)
    }
    if (fields.target_finish_time !== undefined) {
      touched.push('targetTime')
      const value = fields.target_finish_time ?? ''
      setFinishOnly(!value)
      setTargetTime(value)
    }
    if (fields.running_age) {
      touched.push('runningAge')
      setRunningAge(fields.running_age)
    }
    if (fields.current_weekly_km) {
      touched.push('currentWeeklyKm')
      setCurrentWeeklyKm(fields.current_weekly_km)
    }
    if (fields.pb_distance || fields.pb_time) touched.push('pb')
    if (fields.pb_distance) setPbDistance(fields.pb_distance)
    if (fields.pb_time) setPbTime(fields.pb_time)
    if (fields.injuries?.length) {
      touched.push('injuries')
      const hasInjuries = !fields.injuries.includes('none')
      setInjuryFree(!hasInjuries)
      setInjuryText(hasInjuries ? fields.injuries.join('，') : '')
    }
    if (touched.length) markFormEdited(...touched)
  }

  const handleIntakeSubmit = async () => {
    const message = intakeMessage.trim()
    if (!message || intakeLoading || intakeExtracting) return
    const requestRevision = formRevisionRef.current
    setError('')
    setIntakeNotice(null)
    setIntakeExtracting(true)
    try {
      const res = await extractMasterPlanIntake(message)
      if (!res.ok) throw new Error('Coach 暂时无法解析这段描述，请直接填写卡片')
      setIntakeContext((prev) => ({
        goal: prev?.goal ?? null,
        profile: prev?.profile ?? null,
        history: res.data.history,
      }))
      if (formRevisionRef.current === requestRevision) {
        applyExtractedFields(res.data.fields)
        setIntakeNotice(res.data.warning || 'Coach 已把可识别的信息回填到卡片')
      } else {
        setIntakeNotice('你已修改卡片，Coach 结果未覆盖手动输入')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析失败，请直接填写卡片')
    } finally {
      if (mountedRef.current) setIntakeExtracting(false)
    }
  }

  const startGeneration = useCallback(async (nextGoalId?: string | null) => {
    const gen = await generateMasterPlan(nextGoalId ?? undefined)
    if (!gen.ok) {
      const detail = typeof gen.data.detail === 'string' ? gen.data.detail : undefined
      throw new Error(gen.data.error || detail || '生成任务启动失败，请重试')
    }
    if (!mountedRef.current) return
    pollAttemptRef.current = 0
    handledDoneRef.current = false
    setDraftPlanId(null)
    setJobId(gen.data.job_id)
    setJob({
      status: gen.data.status === 'failed' ? 'failed' : 'queued',
      stage: null,
      progress: 0,
      stage_label: '正在准备生成赛季计划',
      context: null,
      result_plan_id: null,
      error: null,
    })
    setPhase('generating')
  }, [])

  const startFullSync = useCallback(async (nextGoalId: string | null) => {
    const existing = await getFullSyncStatus().catch(() => null)
    if (existing?.state === 'done') {
      setGoalId(nextGoalId)
      syncAttemptRef.current = 0
      handledSyncDoneRef.current = true
      setSyncStatus(existing)
      await startGeneration(nextGoalId)
      return
    }
    if (existing?.state === 'running') {
      if (!mountedRef.current) return
      setGoalId(nextGoalId)
      syncAttemptRef.current = 0
      handledSyncDoneRef.current = false
      setSyncStatus(existing)
      setPhase('syncing')
      return
    }
    const sync = await postFullSync()
    if (!sync.ok) {
      const detail = typeof sync.data.detail === 'string' ? sync.data.detail : undefined
      throw new Error(sync.data.error || detail || '历史训练数据同步启动失败，请重试')
    }
    if (!mountedRef.current) return
    setGoalId(nextGoalId)
    syncAttemptRef.current = 0
    handledSyncDoneRef.current = false
    setSyncStatus({
      state: sync.data.state === 'error' ? 'error' : 'running',
      error: sync.data.error,
      progress: sync.data.progress ?? null,
    })
    setPhase('syncing')
  }, [startGeneration])

  const handleGoalSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving || intakeLoading || intakeExtracting) return
    setError('')

    if (!raceDistance) {
      setError('请选择比赛距离')
      return
    }
    if (!weeklyDays) {
      setError('请选择每周训练天数')
      return
    }

    setSaving(true)
    try {
      const goal = await createTrainingGoal({
        type: 'race',
        race_distance: raceDistance,
        race_name: raceName,
        race_date: raceDate,
        target_finish_time: finishOnly ? null : (targetTime.trim() || null),
        weekly_training_days: weeklyDays,
      })
      if (!goal.ok) {
        const detail = typeof goal.data.detail === 'string' ? goal.data.detail : undefined
        setError(goal.data.error || detail || '保存目标失败，请重试')
        setSaving(false)
        return
      }
      const profile = await createRunningProfile({
        running_age: runningAge,
        current_weekly_km: currentWeeklyKm,
        pbs: pbTime.trim() ? [{ distance: pbDistance, time: pbTime.trim() }] : [],
        injuries: injuryFree ? ['none'] : injuryTokens(injuryText),
      })
      if (!profile.ok) {
        const detail = typeof profile.data.detail === 'string' ? profile.data.detail : undefined
        setError(profile.data.error || detail || '保存训练背景失败，请重试')
        setSaving(false)
        return
      }
      await startFullSync(goal.data.goal_id ?? goal.data.id ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败，请重试')
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const pollSync = useCallback(async () => {
    try {
      const next = await getFullSyncStatus()
      if (!mountedRef.current) return
      syncAttemptRef.current += 1
      setSyncStatus(next)

      if (next.state === 'done') {
        if (handledSyncDoneRef.current) return
        handledSyncDoneRef.current = true
        try {
          await startGeneration(goalId)
        } catch (err) {
          setError(err instanceof Error ? err.message : '生成任务启动失败，请重试')
        }
        return
      }

      if (next.state === 'error') {
        setError(next.error || '历史训练数据同步失败，请重试')
        return
      }

      if (syncAttemptRef.current >= MAX_SYNC_POLL_ATTEMPTS) {
        setError('历史训练数据同步超时，请刷新页面查看状态')
      }
    } catch {
      if (!mountedRef.current) return
      syncAttemptRef.current += 1
      if (syncAttemptRef.current >= MAX_SYNC_POLL_ATTEMPTS) {
        setError('无法获取同步状态，请刷新页面')
      }
    }
  }, [goalId, startGeneration])

  const pollJob = useCallback(async () => {
    if (!jobId) return
    try {
      const next = await getMasterPlanJob(jobId)
      if (!mountedRef.current) return
      pollAttemptRef.current += 1
      setJob(next)

      if (next.status === 'done' && next.result_plan_id && !handledDoneRef.current) {
        handledDoneRef.current = true
        setDraftPlanId(next.result_plan_id)
        setPhase('ready')
        return
      }

      if (next.status === 'failed') {
        setError(next.error || '生成失败，请重试')
        return
      }

      if (pollAttemptRef.current >= MAX_POLL_ATTEMPTS) {
        setError('生成超时，请刷新页面查看状态')
      }
    } catch {
      if (!mountedRef.current) return
      pollAttemptRef.current += 1
      if (pollAttemptRef.current >= MAX_POLL_ATTEMPTS) {
        setError('无法获取生成状态，请刷新页面')
      }
    }
  }, [jobId])

  useEffect(() => {
    if (phase !== 'syncing') return undefined
    const id = window.setInterval(() => { void pollSync() }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [phase, pollSync])

  useEffect(() => {
    if (phase !== 'generating' || !jobId) return undefined
    const id = window.setInterval(() => { void pollJob() }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [phase, jobId, pollJob])

  const handleRetry = async () => {
    setError('')
    try {
      if (phase === 'syncing') await startFullSync(goalId)
      else await startGeneration(goalId)
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败，请重试')
    }
  }

  if (phase === 'generating') {
    return (
      <GeneratingProgress
        job={job}
        error={error}
        onRetry={handleRetry}
      />
    )
  }

  if (phase === 'syncing') {
    return <SyncProgressCard status={syncStatus} error={error} onRetry={handleRetry} />
  }

  if (phase === 'ready' && draftPlanId) {
    return <PlanReadyCard planId={draftPlanId} onViewPlan={onDraftReady} />
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green'
  const labelCls = 'block text-xs font-mono text-text-muted uppercase tracking-wider mb-2'
  const intakeHistory = intakeContext?.history ?? null

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
      <section className="space-y-5">
        <div className="rounded-lg border border-border-subtle bg-bg-card p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-green text-white font-mono font-bold">S</div>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-green">Coach 正在收集信息</p>
              <div className="mt-3 rounded-lg rounded-tl-none border border-border-subtle bg-bg-primary p-4 font-editorial text-base leading-7 text-text-primary">
                先把目标赛事、训练背景和约束讲清楚。我会单独整理这些信息，再结合历史比赛与 PB 表现生成赛季计划草稿。
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <IntakeCard
              label="目标比赛"
              value={raceName || '尚未填写'}
              detail={`${setupDistanceLabel(raceDistance)} · ${raceDate || '日期待定'}`}
            />
            <IntakeCard
              label="目标成绩"
              value={finishOnly ? '完赛' : (targetTime || '尚未填写')}
              detail={weeklyDays ? `每周 ${weeklyDays} 天训练` : '训练频率待定'}
            />
            <IntakeCard
              label="训练背景"
              value={weeklyKmLabel(currentWeeklyKm)}
              detail={`${runningAgeLabel(runningAge)} · ${pbTime ? `${pbDistance} ${pbTime}` : 'PB 待补充'}`}
            />
            <IntakeCard
              label="身体限制"
              value={injuryFree ? '没有伤病史' : (injuryText || '待补充')}
              detail="生成前会作为训练负荷边界"
            />
          </div>

          <div className="mt-5 rounded-lg border border-border-subtle bg-bg-primary p-3">
            <textarea
              className="min-h-[96px] w-full resize-none rounded-lg border border-border-subtle bg-bg-card px-3 py-3 text-sm leading-6 text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
              value={intakeMessage}
              onChange={(event) => setIntakeMessage(event.target.value)}
              placeholder="例：目标是 2026 年 10 月 18 日西安马拉松，全马 sub-2:50，一周可以跑 5 天，没有伤病。"
            />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-h-5 text-xs text-text-muted">
                {intakeNotice ?? (intakeLoading ? '正在读取历史数据...' : '历史数据会在同步后自动补全')}
              </p>
              <button
                type="button"
                onClick={handleIntakeSubmit}
                disabled={intakeLoading || intakeExtracting || !intakeMessage.trim()}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent-green px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-green-dim disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SendGlyph />
                {intakeExtracting ? '整理中...' : '发送给 Coach'}
              </button>
            </div>
          </div>
        </div>

        <HistoryInsightPanel history={intakeHistory} loading={intakeLoading} />
      </section>

      <section className="bg-bg-card border border-border-subtle rounded-lg p-6 sm:p-8">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-text-primary">确认计划输入</h2>
          <p className="text-sm text-text-muted mt-1">
            保存后会先同步历史数据，再生成一份可审阅的 draft master plan。
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleGoalSubmit} className="space-y-6">
          {/* 比赛距离 — segmented */}
          <div>
            <label className={labelCls}>比赛距离</label>
            <div className="grid grid-cols-5 gap-2">
              {DISTANCE_OPTIONS.map((opt) => {
                const active = raceDistance === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      markFormEdited('raceDistance')
                      setRaceDistance(opt.value)
                    }}
                    aria-pressed={active}
                    className={`py-2 px-2 rounded-lg text-sm font-medium border transition-colors ${
                      active
                        ? 'border-accent-green bg-accent-green/10 text-accent-green font-semibold'
                        : 'border-border-subtle bg-bg-base text-text-secondary hover:text-text-primary hover:border-border'
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 目标赛事 + 比赛日期 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="master-plan-race-name" className={labelCls}>目标赛事</label>
              <input
                id="master-plan-race-name"
                type="text"
                required
                placeholder="例：上海马拉松 2026"
                value={raceName}
                onChange={(e) => {
                  markFormEdited('raceName')
                  setRaceName(e.target.value)
                }}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="master-plan-race-date" className={labelCls}>比赛日期</label>
              <input
                id="master-plan-race-date"
                type="date"
                required
                value={raceDate}
                onChange={(e) => {
                  markFormEdited('raceDate')
                  setRaceDate(e.target.value)
                }}
                className={inputCls}
              />
            </div>
          </div>

          {/* 每周训练天数 — segmented */}
          <div>
            <label className={labelCls}>每周训练天数</label>
            <div className="flex gap-2">
              {WEEKLY_DAY_OPTIONS.map((days) => {
                const active = weeklyDays === days
                return (
                  <button
                    key={days}
                    type="button"
                    onClick={() => {
                      markFormEdited('weeklyDays')
                      setWeeklyDays(days)
                    }}
                    aria-pressed={active}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      active
                        ? 'border-accent-green bg-accent-green/10 text-accent-green font-semibold'
                        : 'border-border-subtle bg-bg-base text-text-secondary hover:text-text-primary hover:border-border'
                    }`}
                  >
                    {days}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <SegmentedField
              label="跑龄"
              options={RUNNING_AGE_OPTIONS}
              value={runningAge}
              onChange={(value) => {
                markFormEdited('runningAge')
                setRunningAge(value)
              }}
            />
            <SegmentedField
              label="近期周跑量"
              options={WEEKLY_KM_OPTIONS}
              value={currentWeeklyKm}
              onChange={(value) => {
                markFormEdited('currentWeeklyKm')
                setCurrentWeeklyKm(value)
              }}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-[150px_minmax(0,1fr)]">
            <SegmentedField
              label="PB 类型"
              options={PB_OPTIONS}
              value={pbDistance}
              onChange={(value) => {
                markFormEdited('pb')
                setPbDistance(value)
              }}
            />
            <div>
              <label htmlFor="master-plan-pb-time" className={labelCls}>PB 成绩（可选）</label>
              <input
                id="master-plan-pb-time"
                type="text"
                placeholder="例：3:25:00"
                value={pbTime}
                onChange={(e) => {
                  markFormEdited('pb')
                  setPbTime(e.target.value)
                }}
                className={`${inputCls} font-mono tracking-wider`}
              />
            </div>
          </div>

          <div>
            <div className="flex items-end justify-between mb-2">
              <label className="text-xs font-mono text-text-muted uppercase tracking-wider">伤病史</label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={injuryFree}
                  onChange={(e) => {
                    markFormEdited('injuries')
                    setInjuryFree(e.target.checked)
                  }}
                  className="w-4 h-4 rounded border-border-subtle accent-accent-green"
                />
                <span className="text-xs text-text-muted">没有伤病史</span>
              </label>
            </div>
            <input
              id="master-plan-injuries"
              aria-label="伤病史"
              type="text"
              placeholder="例：跟腱、小腿、膝盖"
              value={injuryFree ? '' : injuryText}
              disabled={injuryFree}
              onChange={(e) => {
                markFormEdited('injuries')
                setInjuryText(e.target.value)
              }}
              className={`${inputCls} disabled:opacity-40 disabled:cursor-not-allowed`}
            />
          </div>

          {/* 目标完赛时间 + 仅完赛即可 toggle */}
          <div>
            <div className="flex items-end justify-between mb-2">
              <label className="text-xs font-mono text-text-muted uppercase tracking-wider">目标完赛时间</label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={finishOnly}
                  onChange={(e) => {
                    markFormEdited('targetTime')
                    setFinishOnly(e.target.checked)
                  }}
                  className="w-4 h-4 rounded border-border-subtle accent-accent-green"
                />
                <span className="text-xs text-text-muted">仅完赛即可</span>
              </label>
            </div>
            <input
              id="master-plan-target-time"
              aria-label="目标完赛时间"
              type="text"
              placeholder="例：3:30:00"
              value={finishOnly ? '' : targetTime}
              disabled={finishOnly}
              onChange={(e) => {
                markFormEdited('targetTime')
                setTargetTime(e.target.value)
              }}
              className={`${inputCls} font-mono tracking-wider disabled:opacity-40 disabled:cursor-not-allowed`}
            />
          </div>

          <button
            type="submit"
            disabled={saving || intakeLoading || intakeExtracting}
            className="w-full rounded-lg bg-accent-green/90 px-4 py-2.5 text-sm font-semibold text-bg-base hover:bg-accent-green disabled:cursor-not-allowed disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-2"
          >
            {saving || intakeLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-bg-base/30 border-t-bg-base rounded-full animate-spin" />
                {saving ? '准备中...' : '读取资料中...'}
              </>
            ) : (
              '生成我的赛季计划'
            )}
          </button>
        </form>
      </section>
    </div>
  )
}

function IntakeCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary p-4 transition-colors hover:border-accent-green/45">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</p>
        <EditGlyph />
      </div>
      <p className="truncate text-base font-semibold text-text-primary">{value}</p>
      <p className="mt-1 truncate text-sm text-text-muted">{detail}</p>
    </div>
  )
}

function HistoryInsightPanel({ history, loading }: { history: MasterPlanIntakeHistory | null; loading: boolean }) {
  const pbs = history?.pbs ?? []
  const races = history?.recent_races ?? []
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-cyan">历史表现分析</p>
          <h3 className="mt-1 text-lg font-semibold text-text-primary">比赛与 PB 线索</h3>
        </div>
        {loading && <span className="h-4 w-4 rounded-full border-2 border-accent-cyan/30 border-t-accent-cyan animate-spin" />}
      </div>
      <p className="mb-4 text-sm leading-6 text-text-secondary">
        {history?.summary || '同步完成后会自动分析最近比赛、PB 年龄和比赛表现。'}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border-subtle bg-bg-primary p-4">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">真实 PB</p>
          {pbs.length ? (
            <div className="space-y-2">
              {pbs.slice(0, 4).map((pb) => <PbRow key={pb.distance} pb={pb} />)}
            </div>
          ) : (
            <p className="text-sm text-text-muted">暂无手表 PB 数据</p>
          )}
        </div>
        <div className="rounded-lg border border-border-subtle bg-bg-primary p-4">
          <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">近期比赛样本</p>
          {races.length ? (
            <div className="space-y-2">
              {races.slice(0, 3).map((race) => <RaceEffortRow key={race.label_id} race={race} />)}
            </div>
          ) : (
            <p className="text-sm text-text-muted">暂无可识别比赛样本</p>
          )}
        </div>
      </div>
    </div>
  )
}

function PbRow({ pb }: { pb: MasterPlanIntakePb }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-subtle py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="font-mono text-sm font-semibold text-text-primary">{pb.distance} · {pb.time ?? '--'}</p>
        <p className="truncate text-xs text-text-muted">{pb.activity_name || pb.source || 'synced watch data'}</p>
      </div>
      <p className="shrink-0 text-right font-mono text-[11px] text-text-muted">
        {pb.achieved_at ?? '--'}{pb.days_since != null ? ` · ${pb.days_since}d` : ''}
      </p>
    </div>
  )
}

function RaceEffortRow({ race }: { race: MasterPlanIntakeRaceEffort }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-subtle py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-text-primary">{race.name || race.distance_label}</p>
        <p className="font-mono text-xs text-text-muted">{race.distance_km}km · {race.duration ?? '--'} · {race.pace ?? '--'}/km</p>
      </div>
      <p className="shrink-0 text-right font-mono text-[11px] text-text-muted">
        {race.date}{race.avg_hr != null ? ` · ${Math.round(race.avg_hr)}bpm` : ''}
      </p>
    </div>
  )
}

function SegmentedField<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div>
      <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-2">{label}</label>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => {
          const active = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              aria-pressed={active}
              className={`py-2 px-2 rounded-lg text-sm font-medium border transition-colors ${
                active
                  ? 'border-accent-green bg-accent-green/10 text-accent-green font-semibold'
                  : 'border-border-subtle bg-bg-base text-text-secondary hover:text-text-primary hover:border-border'
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function injuryTokens(value: string): string[] {
  const cleaned = value.trim()
  if (!cleaned) return ['none']
  return cleaned.split(/[，,、\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 6)
}

function setupDistanceLabel(value: RaceDistance | ''): string {
  if (!value) return '距离待定'
  return DISTANCE_OPTIONS.find((item) => item.value === value)?.label ?? value
}

function runningAgeLabel(value: RunningAge): string {
  return RUNNING_AGE_OPTIONS.find((item) => item.value === value)?.label ?? value
}

function weeklyKmLabel(value: CurrentWeeklyKm): string {
  return WEEKLY_KM_OPTIONS.find((item) => item.value === value)?.label ?? value
}

function SendGlyph() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </svg>
  )
}

function EditGlyph() {
  return (
    <svg className="h-4 w-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function SyncProgressCard({ status, error, onRetry }: { status: SyncStatus | null; error: string; onRetry: () => void }) {
  const failed = Boolean(error) || status?.state === 'error'
  const progress = status?.progress ?? null
  const percent = clampPercent(progress?.percent ?? (failed ? 100 : 8))
  const message = failed
    ? error || status?.error || '历史训练数据同步失败'
    : progress?.message || '正在同步历史训练数据'

  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-bg-card border border-border-subtle rounded-lg p-6 sm:p-8 space-y-6">
        <div>
          <p className="font-mono text-[10px] text-accent-green tracking-[0.14em] font-semibold uppercase mb-1.5">
            {failed ? '同步遇到问题' : '同步历史训练数据'}
          </p>
          <h2 className="text-xl font-bold text-text-primary">
            {failed ? '无法完成历史数据同步' : '正在读取你的训练历史'}
          </h2>
          <p className="text-sm text-text-muted mt-1">
            生成赛季计划前需要完整训练历史，这一步可能需要几分钟。
          </p>
        </div>
        <div>
          <div className="flex justify-between text-xs font-mono text-text-muted mb-2">
            <span>{message}</span>
            <span>{percent}%</span>
          </div>
          <div className="h-2 rounded-full bg-border-subtle overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-accent-red' : 'bg-accent-green'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <ContextStat label="当前阶段" value={progress?.phase ?? 'queued'} />
          <ContextStat label="已同步活动" value={progress?.synced_activities != null ? String(progress.synced_activities) : '—'} />
          <ContextStat label="健康天数" value={progress?.synced_health != null ? String(progress.synced_health) : '—'} />
        </div>
        {failed && (
          <button
            onClick={onRetry}
            className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-white hover:bg-accent-green transition-colors cursor-pointer"
          >
            重新同步
          </button>
        )}
      </div>
    </div>
  )
}

function PlanReadyCard({ planId, onViewPlan }: { planId: string; onViewPlan: (planId: string) => void }) {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-bg-card border border-border-subtle rounded-lg p-6 sm:p-8 space-y-5">
        <div>
          <p className="font-mono text-[10px] text-accent-green tracking-[0.14em] font-semibold uppercase mb-1.5">计划已生成</p>
          <h2 className="text-xl font-bold text-text-primary">赛季计划草稿已准备好</h2>
          <p className="text-sm text-text-muted mt-1">
            下一步先审阅计划。确认启用前，它还不会成为你的正式 master plan。
          </p>
        </div>
        <button
          type="button"
          onClick={() => onViewPlan(planId)}
          className="inline-flex h-10 items-center justify-center rounded-lg bg-accent-green px-5 text-sm font-semibold text-white hover:bg-accent-green-dim transition-colors"
        >
          查看计划
        </button>
      </div>
    </div>
  )
}

// ─── Generating progress (screen 2) ─────────────────────────────────────────

function GeneratingProgress({
  job,
  error,
  onRetry,
}: {
  job: MasterPlanJob | null
  error: string
  onRetry: () => void
}) {
  const failed = Boolean(error) || job?.status === 'failed'
  const done = job?.status === 'done'
  const activeStepIndex = getActiveStepIndex(job, done)
  const percent = clampPercent(done ? 100 : job?.progress ?? 0)
  const message = failed
    ? error || job?.error || '生成失败，请重试'
    : done
      ? '赛季计划草稿已生成'
      : job?.stage_label || '正在为你推演赛季…'
  const ctx = job?.context ?? null

  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-bg-card border border-border-subtle rounded-lg p-6 sm:p-8 space-y-6">
        <div>
          <p className="font-mono text-[10px] text-accent-green tracking-[0.14em] font-semibold uppercase mb-1.5">
            {failed ? '生成遇到问题' : '生成中'}
          </p>
          <h2 className="text-xl font-bold text-text-primary">
            {failed ? '赛季计划生成失败' : '正在为你推演赛季…'}
          </h2>
          <p className="text-sm text-text-muted mt-1">
            {failed
              ? '请检查网络或稍后重试。'
              : 'STRIDE 正在读取你的训练史、评估体能、规划周期，并校验每一周的安全性。'}
          </p>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-xs font-mono text-text-muted mb-2">
            <span>{message}</span>
            <span>{percent}%</span>
          </div>
          <div className="h-2 rounded-full bg-border-subtle overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-accent-red' : 'bg-accent-green'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-[1fr_220px]">
          {/* Vertical stepper */}
          <div className="space-y-3">
            {GEN_STEPS.map((step, index) => {
              const state = getStepState(index, activeStepIndex, failed)
              const subLabel =
                state === 'active' && !failed
                  ? job?.stage_label ?? '进行中…'
                  : step.hint
              return (
                <div key={step.title} className="flex gap-3">
                  <div className="pt-0.5">
                    <StepDot state={state} />
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${state === 'pending' ? 'text-text-muted' : 'text-text-primary'}`}>
                      {step.title}
                    </p>
                    {subLabel && (
                      <p className={`text-xs mt-0.5 font-mono ${state === 'active' && !failed ? 'text-accent-green' : 'text-text-muted'}`}>
                        {subLabel}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Live data context */}
          <aside className="rounded-lg border border-border-subtle bg-bg-base p-4">
            <p className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-2 mb-3">
              Live Data Context
            </p>
            <div className="space-y-3">
              <ContextStat label="近期均量" value={fmtKm(ctx?.avg_weekly_km)} />
              <ContextStat label="最长跑" value={fmtKm(ctx?.max_weekly_km)} />
              <ContextStat label="距赛" value={ctx?.weeks_to_race != null ? `${ctx.weeks_to_race} 周` : '—'} />
              <ContextStat label="CTL / ATL" value={fmtLoad(ctx?.chronic_load, ctx?.acute_load)} />
              {ctx?.form != null && <ContextStat label="Form" value={String(Math.round(ctx.form))} />}
            </div>
            {ctx?.fitness_summary && (
              <p className="text-xs text-text-muted mt-4 pt-3 border-t border-border-subtle leading-relaxed">
                {ctx.fitness_summary}
              </p>
            )}
          </aside>
        </div>

        {failed && (
          <button
            onClick={onRetry}
            className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green transition-colors cursor-pointer"
          >
            重新生成
          </button>
        )}
      </div>
    </div>
  )
}

function ContextStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-lg font-semibold text-text-primary mt-0.5">{value}</p>
    </div>
  )
}

function StepDot({ state }: { state: 'done' | 'active' | 'pending' | 'error' }) {
  if (state === 'done') return <span className="flex w-5 h-5 items-center justify-center rounded-full bg-accent-green text-bg-base text-xs">✓</span>
  if (state === 'error') return <span className="flex w-5 h-5 items-center justify-center rounded-full bg-accent-red text-bg-base text-xs">!</span>
  if (state === 'active') return <span className="flex w-5 h-5 items-center justify-center rounded-full border-2 border-accent-green"><span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" /></span>
  return <span className="block w-5 h-5 rounded-full border border-border-subtle bg-bg-base" />
}

function getActiveStepIndex(job: MasterPlanJob | null, done: boolean): number {
  if (done) return GEN_STEPS.length - 1 // 完成
  const stage = job?.stage
  if (!stage) return 0
  const index = GEN_STEPS.findIndex((step) => step.stages.includes(stage))
  return index === -1 ? 0 : index
}

function getStepState(index: number, activeStepIndex: number, failed: boolean): 'done' | 'active' | 'pending' | 'error' {
  if (failed && index === activeStepIndex) return 'error'
  if (index < activeStepIndex) return 'done'
  if (index === activeStepIndex) return 'active'
  return 'pending'
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function fmtKm(value: number | undefined): string {
  if (value == null) return '—'
  return `${Math.round(value)} km`
}

function fmtLoad(chronic: number | undefined, acute: number | undefined): string {
  if (chronic == null && acute == null) return '—'
  return `${chronic != null ? Math.round(chronic) : '—'} / ${acute != null ? Math.round(acute) : '—'}`
}
