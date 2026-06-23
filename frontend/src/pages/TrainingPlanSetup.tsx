import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createTrainingGoal,
  generateMasterPlan,
  getMasterPlanJob,
  confirmMasterPlan,
  type RaceDistance,
  type WeeklyTrainingDays,
  type MasterPlanJob,
  type MasterPlanJobStage,
} from '../api'

type SetupPhase = 'goals' | 'generating'

const POLL_INTERVAL_MS = 1500
const MAX_POLL_ATTEMPTS = 400 // 400 * 1.5s = 10 min

const DISTANCE_OPTIONS: { value: RaceDistance; label: string }[] = [
  { value: '5K', label: '5K' },
  { value: '10K', label: '10K' },
  { value: 'HM', label: '半马' },
  { value: 'FM', label: '全马' },
  { value: 'trail', label: '越野' },
]

const WEEKLY_DAY_OPTIONS: WeeklyTrainingDays[] = [3, 4, 5, 6]

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
  onComplete: () => void
}

export default function TrainingPlanSetup({ onComplete }: Props) {
  const [phase, setPhase] = useState<SetupPhase>('goals')

  // ── Goal form state ──────────────────────────────────────────────────────
  const [raceDistance, setRaceDistance] = useState<RaceDistance | ''>('')
  const [raceName, setRaceName] = useState('')
  const [raceDate, setRaceDate] = useState('')
  const [weeklyDays, setWeeklyDays] = useState<WeeklyTrainingDays | ''>('')
  const [finishOnly, setFinishOnly] = useState(false)
  const [targetTime, setTargetTime] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // ── Generating state ─────────────────────────────────────────────────────
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<MasterPlanJob | null>(null)
  const [confirming, setConfirming] = useState(false)
  const pollAttemptRef = useRef(0)
  const handledDoneRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const startGeneration = useCallback(async (goalId?: string) => {
    const gen = await generateMasterPlan(goalId)
    if (!gen.ok) {
      const detail = typeof gen.data.detail === 'string' ? gen.data.detail : undefined
      throw new Error(gen.data.error || detail || '生成任务启动失败，请重试')
    }
    if (!mountedRef.current) return
    pollAttemptRef.current = 0
    handledDoneRef.current = false
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
      await startGeneration(goal.data.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败，请重试')
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  const pollJob = useCallback(async () => {
    if (!jobId) return
    try {
      const next = await getMasterPlanJob(jobId)
      if (!mountedRef.current) return
      pollAttemptRef.current += 1
      setJob(next)

      if (next.status === 'done' && next.result_plan_id && !handledDoneRef.current) {
        handledDoneRef.current = true
        setConfirming(true)
        try {
          await confirmMasterPlan(next.result_plan_id)
        } catch {
          // Confirm is idempotent-ish; even if it failed (e.g. already active),
          // reload so the parent fetches the current plan and decides.
        }
        if (mountedRef.current) onComplete()
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
  }, [jobId, onComplete])

  useEffect(() => {
    if (phase !== 'generating' || !jobId) return undefined
    const id = window.setInterval(() => { void pollJob() }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [phase, jobId, pollJob])

  const handleRetry = async () => {
    setError('')
    try {
      await startGeneration()
    } catch (err) {
      setError(err instanceof Error ? err.message : '请求失败，请重试')
    }
  }

  if (phase === 'generating') {
    return (
      <GeneratingProgress
        job={job}
        error={error}
        confirming={confirming}
        onRetry={handleRetry}
      />
    )
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green'
  const labelCls = 'block text-xs font-mono text-text-muted uppercase tracking-wider mb-2'

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 sm:p-8">
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
              <label className={labelCls}>目标赛事</label>
              <input
                type="text"
                required
                placeholder="例：上海马拉松 2026"
                value={raceName}
                onChange={(e) => setRaceName(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>比赛日期</label>
              <input
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

// ─── Generating progress (screen 2) ─────────────────────────────────────────

function GeneratingProgress({
  job,
  error,
  confirming,
  onRetry,
}: {
  job: MasterPlanJob | null
  error: string
  confirming: boolean
  onRetry: () => void
}) {
  const failed = Boolean(error) || job?.status === 'failed'
  const done = job?.status === 'done' || confirming
  const activeStepIndex = getActiveStepIndex(job, done)
  const percent = clampPercent(done ? 100 : job?.progress ?? 0)
  const message = failed
    ? error || job?.error || '生成失败，请重试'
    : confirming
      ? '正在确认并激活赛季计划'
      : job?.stage_label || '正在为你推演赛季…'
  const ctx = job?.context ?? null

  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 sm:p-8 space-y-6">
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
          <aside className="rounded-xl border border-border-subtle bg-bg-base p-4">
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
