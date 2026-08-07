import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createRunningProfile,
  createTrainingGoal,
  generateMasterPlan,
  getFullSyncStatus,
  getMasterPlanJob,
  postFullSync,
  type RaceDistance,
  type CurrentWeeklyKm,
  type RunningAge,
  type RunningPbDistance,
  type WeeklyTrainingDays,
  type MasterPlanJob,
  type MasterPlanJobStage,
  type SyncStatus,
} from '../api'

type SetupPhase = 'goals' | 'syncing' | 'generating' | 'ready'

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

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

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

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_460px]">
      <aside className="rounded-lg border border-border-subtle bg-bg-card p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-green text-white font-mono font-bold">S</div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-green">Coach Intake</p>
            <h2 className="text-lg font-semibold text-text-primary">先把目标讲清楚</h2>
          </div>
        </div>
        <div className="space-y-4 text-sm leading-6 text-text-secondary">
          <p className="font-editorial text-base leading-7 text-text-primary">
            我会先确认目标赛事、每周可训练天数和成绩目标，然后同步历史训练数据，再生成一份可审阅的赛季计划草稿。
          </p>
          <IntakeFact label="数据来源" value="手表历史训练 + 健康指标" />
          <IntakeFact label="生成结果" value="Draft master plan，确认后才会启用" />
          <IntakeFact label="审阅方式" value="计划生成后可在右侧 Coach 窗口继续反馈" />
        </div>
      </aside>

      <div className="bg-bg-card border border-border-subtle rounded-lg p-6 sm:p-8">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-text-primary">创建你的赛季计划</h2>
          <p className="text-sm text-text-muted mt-1">
            STRIDE 会根据你的目标和训练史，倒推出一份周期化赛季计划。
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
                    onClick={() => setRaceDistance(opt.value)}
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
                onChange={(e) => setRaceName(e.target.value)}
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
                onChange={(e) => setRaceDate(e.target.value)}
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
                    onClick={() => setWeeklyDays(days)}
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
              onChange={setRunningAge}
            />
            <SegmentedField
              label="近期周跑量"
              options={WEEKLY_KM_OPTIONS}
              value={currentWeeklyKm}
              onChange={setCurrentWeeklyKm}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-[150px_minmax(0,1fr)]">
            <SegmentedField
              label="PB 类型"
              options={PB_OPTIONS}
              value={pbDistance}
              onChange={setPbDistance}
            />
            <div>
              <label htmlFor="master-plan-pb-time" className={labelCls}>PB 成绩（可选）</label>
              <input
                id="master-plan-pb-time"
                type="text"
                placeholder="例：3:25:00"
                value={pbTime}
                onChange={(e) => setPbTime(e.target.value)}
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
                  onChange={(e) => setInjuryFree(e.target.checked)}
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
              onChange={(e) => setInjuryText(e.target.value)}
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
                  onChange={(e) => setFinishOnly(e.target.checked)}
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
              onChange={(e) => setTargetTime(e.target.value)}
              className={`${inputCls} font-mono tracking-wider disabled:opacity-40 disabled:cursor-not-allowed`}
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg bg-accent-green/90 px-4 py-2.5 text-sm font-semibold text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <span className="w-4 h-4 border-2 border-bg-base/30 border-t-bg-base rounded-full animate-spin" />
                生成中...
              </>
            ) : (
              '生成我的赛季计划'
            )}
          </button>
        </form>
      </div>
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

function IntakeFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-primary p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold text-text-primary">{value}</p>
    </div>
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
