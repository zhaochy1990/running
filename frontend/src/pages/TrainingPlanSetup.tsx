import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  patchMyProfile,
  postFullSync,
  getFullSyncStatus,
  type TargetDistance,
  type SyncStatus,
} from '../api'

type SetupPhase = 'goals' | 'syncing' | 'done'

const MAX_POLL_ATTEMPTS = 200 // 200 * 3s = 10 min
const POLL_INTERVAL_MS = 3000

const PROGRESS_STEPS = [
  {
    title: '提交任务',
    description: '连接手表并准备同步',
    phases: ['queued', 'connecting'],
  },
  {
    title: '扫描训练',
    description: '查找手表历史训练记录',
    phases: ['activities_scan'],
  },
  {
    title: '同步详情',
    description: '下载配速、心率、分段数据',
    phases: ['activity_details', 'activity_save', 'commentary', 'ability', 'activities_done'],
  },
  {
    title: '健康指标',
    description: '同步疲劳、训练负荷数据',
    phases: ['health', 'dashboard', 'health_done'],
  },
  {
    title: '完成',
    description: '数据准备就绪，可以生成训练计划',
    phases: ['finalizing', 'complete'],
  },
]

interface Props {
  onComplete: () => void
}

export default function TrainingPlanSetup({ onComplete }: Props) {
  const [phase, setPhase] = useState<SetupPhase>('goals')
  const [targetRace, setTargetRace] = useState('')
  const [targetDistance, setTargetDistance] = useState<TargetDistance | ''>('')
  const [targetRaceDate, setTargetRaceDate] = useState('')
  const [targetTime, setTargetTime] = useState('')
  const [pb5k, setPb5k] = useState('')
  const [pb10k, setPb10k] = useState('')
  const [pbHm, setPbHm] = useState('')
  const [pbFm, setPbFm] = useState('')
  const [weeklyMileage, setWeeklyMileage] = useState('')
  const [constraints, setConstraints] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const pollAttemptRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    // Check if a full sync is already running
    getFullSyncStatus()
      .then((status) => {
        if (!mountedRef.current) return
        if (status.state === 'running') {
          setSyncStatus(status)
          setPhase('syncing')
        } else if (status.state === 'done') {
          onComplete()
        }
      })
      .catch(() => {})
    return () => { mountedRef.current = false }
  }, [onComplete])

  const handleGoalSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setSaving(true)

    if (!targetDistance) {
      setError('请选择目标距离')
      setSaving(false)
      return
    }

    const pbs: Record<string, string> = {}
    if (pb5k) pbs['5k'] = pb5k
    if (pb10k) pbs['10k'] = pb10k
    if (pbHm) pbs['hm'] = pbHm
    if (pbFm) pbs['fm'] = pbFm

    try {
      // Save race goals to profile
      const patch = await patchMyProfile({
        target_race: targetRace,
        target_distance: targetDistance,
        target_race_date: targetRaceDate,
        target_time: targetTime,
        ...(Object.keys(pbs).length > 0 && { pbs }),
        ...(weeklyMileage && { weekly_mileage_km: parseFloat(weeklyMileage) }),
        ...(constraints && { constraints }),
      })
      if (!patch.ok) {
        setError('保存目标失败，请重试')
        setSaving(false)
        return
      }

      // Trigger full sync
      const { ok, data } = await postFullSync()
      if (!ok) {
        setError(data.error || data.detail || '启动同步失败，请重试')
        setSaving(false)
        return
      }

      setSyncStatus({
        state: 'running',
        progress: data.progress ?? {
          phase: 'queued',
          message: '正在准备同步历史训练数据',
          percent: 0,
        },
      })
      setPhase('syncing')
    } catch {
      setError('请求失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const checkSyncStatus = useCallback(async () => {
    try {
      const status = await getFullSyncStatus()
      if (!mountedRef.current) return

      pollAttemptRef.current += 1
      setSyncStatus(status)

      if (status.state === 'done') {
        onComplete()
        return
      }

      if (status.state === 'error') {
        setError(status.error || '同步出错，请重试')
        return
      }

      if (status.state === 'running' && pollAttemptRef.current >= MAX_POLL_ATTEMPTS) {
        setError('同步超时，请刷新页面查看状态')
      }
    } catch {
      if (!mountedRef.current) return
      pollAttemptRef.current += 1
      if (pollAttemptRef.current >= MAX_POLL_ATTEMPTS) {
        setError('无法获取同步状态，请刷新页面')
      }
    }
  }, [onComplete])

  useEffect(() => {
    if (phase !== 'syncing') return undefined
    const intervalId = window.setInterval(() => {
      void checkSyncStatus()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(intervalId)
  }, [phase, checkSyncStatus])

  const handleRetrySync = async () => {
    setError('')
    pollAttemptRef.current = 0
    try {
      const { ok, data } = await postFullSync()
      if (!ok) {
        setError(data.error || data.detail || '启动同步失败')
        return
      }
      setSyncStatus({
        state: 'running',
        progress: data.progress ?? { phase: 'queued', percent: 0 },
      })
      setPhase('syncing')
    } catch {
      setError('请求失败，请重试')
    }
  }

  if (phase === 'syncing') {
    return (
      <FullSyncProgress
        status={syncStatus}
        error={error}
        onRetry={handleRetrySync}
      />
    )
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green'

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 sm:p-8">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-text-primary">设置训练目标</h2>
          <p className="text-sm text-text-muted mt-1">
            填写你的比赛目标，我们会同步历史训练数据来生成个性化训练计划
          </p>
        </div>

        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400 mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleGoalSubmit} className="space-y-6">
          {/* Race Goal */}
          <section className="space-y-4">
            <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">
              目标赛事
            </h3>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">目标比赛</label>
              <input
                type="text"
                required
                placeholder="例：上海马拉松 2026"
                value={targetRace}
                onChange={(e) => setTargetRace(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">目标距离</label>
              <select
                required
                value={targetDistance}
                onChange={(e) => setTargetDistance(e.target.value as TargetDistance | '')}
                className={inputCls}
              >
                <option value="">请选择</option>
                <option value="5K">5K</option>
                <option value="10K">10K</option>
                <option value="HM">半马 (HM)</option>
                <option value="FM">全马 (FM)</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">比赛日期</label>
                <input
                  type="date"
                  required
                  value={targetRaceDate}
                  onChange={(e) => setTargetRaceDate(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">目标成绩 (H:MM:SS)</label>
                <input
                  type="text"
                  required
                  placeholder="例：3:30:00"
                  value={targetTime}
                  onChange={(e) => setTargetTime(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
          </section>

          {/* Baseline */}
          <section className="space-y-4">
            <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">
              训练基线（选填）
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">5K PB</label>
                <input type="text" placeholder="例：20:30" value={pb5k} onChange={(e) => setPb5k(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">10K PB</label>
                <input type="text" placeholder="例：42:00" value={pb10k} onChange={(e) => setPb10k(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">半马 PB</label>
                <input type="text" placeholder="例：1:32:00" value={pbHm} onChange={(e) => setPbHm(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">全马 PB</label>
                <input type="text" placeholder="例：3:10:00" value={pbFm} onChange={(e) => setPbFm(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">当前周跑量 (km)</label>
              <input type="number" min="0" max="300" step="1" value={weeklyMileage} onChange={(e) => setWeeklyMileage(e.target.value)} className={inputCls} />
            </div>
          </section>

          {/* Constraints */}
          <section className="space-y-4">
            <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-1">
              限制条件（选填）
            </h3>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">伤病 / 注意事项</label>
              <textarea
                rows={3}
                placeholder="例：左膝轻微髌骨疼痛，避免下坡跑"
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green resize-none"
              />
            </div>
          </section>

          {/* Warning about sync duration */}
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-sm font-medium text-amber-400">需要同步历史数据</p>
            <p className="text-xs text-text-muted mt-1">
              提交后将同步手表中近 3 年的训练和健康数据，用于分析你的跑步能力并生成训练计划。
              数据量较大，可能需要 3-5 分钟，请耐心等待。
            </p>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-2"
          >
            {saving ? (
              <>
                <span className="w-4 h-4 border-2 border-bg-base/30 border-t-bg-base rounded-full animate-spin" />
                保存中...
              </>
            ) : (
              '保存目标并同步数据'
            )}
          </button>
        </form>
      </div>
    </div>
  )
}

// ─── Full Sync Progress ─────────────────────────────────────────────────────

function FullSyncProgress({
  status,
  error,
  onRetry,
}: {
  status: SyncStatus | null
  error: string
  onRetry: () => void
}) {
  const failed = Boolean(error) || status?.state === 'error'
  const progress = status?.progress ?? null
  const phase = failed ? progress?.failed_phase ?? progress?.phase ?? 'queued' : progress?.phase ?? 'queued'
  const activeStepIndex = getActiveStepIndex(phase)
  const percent = clampPercent(failed ? progress?.percent ?? 0 : progress?.percent ?? 3)
  const message = failed
    ? error || status?.error || '同步失败，请重试'
    : progress?.message ?? '正在同步历史训练数据'
  const current = progress?.current
  const total = progress?.total
  const showCurrentTotal = typeof current === 'number' && typeof total === 'number' && total > 0

  return (
    <div className="max-w-lg mx-auto">
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 sm:p-8 space-y-6">
        <div>
          <h2 className="text-xl font-bold text-text-primary">
            {failed ? '同步遇到问题' : '正在同步历史数据'}
          </h2>
          <p className="text-sm text-text-muted mt-1">
            {failed
              ? '请检查网络或手表账号状态后重试。'
              : '正在同步手表中的训练和健康数据，这可能需要几分钟。你可以离开此页面，同步会在后台继续。'}
          </p>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-base p-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium text-text-primary">{message}</p>
            {!failed && (
              <span className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin shrink-0" />
            )}
          </div>

          <div>
            <div className="flex justify-between text-xs font-mono text-text-muted mb-2">
              <span>同步进度</span>
              <span>{percent}%</span>
            </div>
            <div className="h-2 rounded-full bg-border-subtle overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-accent-red' : 'bg-accent-green'}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          {(showCurrentTotal || typeof progress?.synced_activities === 'number' || typeof progress?.synced_health === 'number') && (
            <div className="grid grid-cols-3 gap-3 pt-1">
              {showCurrentTotal && (
                <StatBox label="当前批次" value={`${current}/${total}`} />
              )}
              {typeof progress?.synced_activities === 'number' && (
                <StatBox label="活动写入" value={`${progress.synced_activities}`} />
              )}
              {typeof progress?.synced_health === 'number' && (
                <StatBox label="健康天数" value={`${progress.synced_health}`} />
              )}
            </div>
          )}
        </div>

        <div className="space-y-3">
          {PROGRESS_STEPS.map((step, index) => {
            const state = getStepState(index, activeStepIndex, failed)
            return (
              <div key={step.title} className="flex gap-3">
                <div className="pt-0.5">
                  <StepDot state={state} />
                </div>
                <div>
                  <p className={`text-sm font-medium ${state === 'pending' ? 'text-text-muted' : 'text-text-primary'}`}>
                    {step.title}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">{step.description}</p>
                </div>
              </div>
            )
          })}
        </div>

        {failed && (
          <button
            onClick={onRetry}
            className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green transition-colors cursor-pointer"
          >
            重新同步
          </button>
        )}
      </div>
    </div>
  )
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card px-3 py-2">
      <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-sm font-semibold text-text-primary mt-1">{value}</p>
    </div>
  )
}

function StepDot({ state }: { state: 'done' | 'active' | 'pending' | 'error' }) {
  if (state === 'done') return <span className="flex w-5 h-5 items-center justify-center rounded-full bg-accent-green text-bg-base text-xs">✓</span>
  if (state === 'error') return <span className="flex w-5 h-5 items-center justify-center rounded-full bg-accent-red text-bg-base text-xs">!</span>
  if (state === 'active') return <span className="flex w-5 h-5 items-center justify-center rounded-full border-2 border-accent-green"><span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" /></span>
  return <span className="block w-5 h-5 rounded-full border border-border-subtle bg-bg-base" />
}

function getActiveStepIndex(phase: string) {
  const index = PROGRESS_STEPS.findIndex((step) => step.phases.includes(phase))
  return index === -1 ? 0 : index
}

function getStepState(index: number, activeStepIndex: number, failed: boolean) {
  if (failed && index === activeStepIndex) return 'error'
  if (index < activeStepIndex) return 'done'
  if (index === activeStepIndex) return 'active'
  return 'pending'
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)))
}
