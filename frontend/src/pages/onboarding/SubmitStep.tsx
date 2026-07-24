import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postOnboardingComplete, getSyncStatus, type ProfileIn, type SyncProgress, type SyncStatus } from '../../api'

interface Props {
  profile: ProfileIn
  /**
   * When true (config `sync_data_at_onboarding`), onboarding blocks on a full
   * watch-history sync (minutes) and silently resumes if interrupted. When
   * false, the fast health-only sync (~10s) is used.
   */
  syncFullHistory?: boolean
}

const POLL_INTERVAL_MS = 2000
const HEALTH_MAX_POLL_ATTEMPTS = 120 // 120 * 2s = 4 min (health-only sync is fast)
const FULL_MAX_POLL_ATTEMPTS = 1800 // 1800 * 2s = 60 min (full history sync can be long)
// Silent auto-resumes before we stop hiding the failure and surface a retry.
const MAX_AUTO_RESUME = 3

const HEALTH_PROGRESS_STEPS = [
  { title: '提交任务', description: '连接手表并启动同步', phases: ['queued', 'connecting'] },
  {
    title: '健康指标',
    description: '同步疲劳、训练负荷和仪表盘数据',
    phases: ['health', 'dashboard', 'health_done'],
  },
  { title: '完成', description: '进入训练仪表盘', phases: ['finalizing', 'complete'] },
]

const FULL_PROGRESS_STEPS = [
  { title: '提交任务', description: '连接手表并启动同步', phases: ['queued', 'connecting'] },
  {
    title: '同步训练与健康数据',
    description: '下载历史活动、疲劳与负荷数据',
    phases: [
      'activities_scan',
      'activity_details',
      'activities_done',
      'activity_save',
      'health',
      'dashboard',
      'health_done',
    ],
  },
  {
    title: '分析并初始化',
    description: '校准训练区间、计算负荷与能力模型',
    phases: ['calibrating', 'scoring', 'finalizing', 'complete'],
  },
]

// Phases the full-history sync emits that the health-only sync never does.
// Used to infer the sync method from live progress so the copy is right even
// when the config flag wasn't available at mount (e.g. a stale profile fetch).
const FULL_ONLY_PHASES = new Set<string>([
  'activities_scan',
  'activity_details',
  'activities_done',
  'activity_save',
  'calibrating',
  'scoring',
  'training_load',
])

function phaseImpliesFullSync(progress: SyncProgress | null | undefined): boolean {
  if (!progress) return false
  return FULL_ONLY_PHASES.has(progress.phase ?? '') || FULL_ONLY_PHASES.has(progress.failed_phase ?? '')
}

export default function SubmitStep({ profile, syncFullHistory = false }: Props) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const pollAttemptRef = useRef(0)
  const mountedRef = useRef(false)
  const autoResumeRef = useRef(0)
  const resumingRef = useRef(false)

  // Reflect the ACTUAL sync method: prefer the config flag, but fall back to the
  // sync's own progress phases so the copy self-corrects even if the flag wasn't
  // available at mount (e.g. a stale profile fetch).
  const isFullSync = syncFullHistory || phaseImpliesFullSync(syncStatus?.progress)
  const steps = isFullSync ? FULL_PROGRESS_STEPS : HEALTH_PROGRESS_STEPS

  const startSync = useCallback(async (): Promise<void> => {
    setError('')
    setStarted(true)
    setLoading(true)
    pollAttemptRef.current = 0

    try {
      const { ok, data } = await postOnboardingComplete()
      if (!mountedRef.current) return

      if (!ok) {
        setError(data.error || data.detail || '初始化请求失败，请重试')
        setLoading(false)
        return
      }

      if ((data as { state?: string }).state === 'already-complete') {
        navigate('/')
        return
      }

      setSyncStatus({
        state: 'running',
        progress: data.progress ?? {
          phase: 'queued',
          message: syncFullHistory ? '正在同步完整历史训练数据，这可能需要几分钟' : '正在同步健康数据，马上就好',
          percent: 0,
        },
      })
    } catch {
      if (!mountedRef.current) return
      setError('请求失败，请重试')
      setLoading(false)
    }
  }, [navigate, syncFullHistory])

  const applyStatus = useCallback(
    (status: SyncStatus) => {
      if (status.state === 'done') {
        setSyncStatus(status)
        setLoading(false)
        navigate('/')
        return
      }

      if (status.state === 'error') {
        // Full-history mode: a crashed/interrupted sync resumes silently
        // (server uses full=False → picks up where it left off) without any
        // "interrupted" wording, up to MAX_AUTO_RESUME times. Detect "full" from
        // the failed phase too, not just the config flag.
        const full = syncFullHistory || phaseImpliesFullSync(status.progress)
        if (full && autoResumeRef.current < MAX_AUTO_RESUME && !resumingRef.current) {
          autoResumeRef.current += 1
          resumingRef.current = true
          setError('')
          setStarted(true)
          setLoading(true)
          void startSync().finally(() => {
            resumingRef.current = false
          })
          return
        }
        setSyncStatus(status)
        setError(status.error || '同步出错，请重试')
        setLoading(false)
        setStarted(true)
        return
      }

      if (status.state === 'running') {
        setSyncStatus(status)
        setError('')
        setStarted(true)
        setLoading(true)
        return
      }

      // null / unknown — before the user has started onboarding.
      setSyncStatus(status)
    },
    [navigate, startSync, syncFullHistory],
  )

  const checkSyncStatus = useCallback(async () => {
    try {
      const status = await getSyncStatus()
      if (!mountedRef.current) return

      pollAttemptRef.current += 1
      applyStatus(status)

      const full = syncFullHistory || phaseImpliesFullSync(status.progress)
      const cap = full ? FULL_MAX_POLL_ATTEMPTS : HEALTH_MAX_POLL_ATTEMPTS
      if (status.state === 'running' && pollAttemptRef.current >= cap) {
        setError(
          full
            ? '同步耗时较长，请保持页面打开，或稍后在通知中心查看进度'
            : '同步超时，请刷新页面查看状态',
        )
        setLoading(false)
      }
    } catch {
      if (!mountedRef.current) return

      pollAttemptRef.current += 1
      // On repeated fetch failures use the generous full cap so a slow full sync
      // isn't aborted; a health-only sync would have completed long before.
      const cap = syncFullHistory ? FULL_MAX_POLL_ATTEMPTS : HEALTH_MAX_POLL_ATTEMPTS
      if (pollAttemptRef.current >= cap) {
        setError('无法获取同步状态，请刷新页面')
        setLoading(false)
      }
    }
  }, [applyStatus, syncFullHistory])

  useEffect(() => {
    mountedRef.current = true

    // Resume-on-reopen: if a sync is already running/done/error server-side,
    // pick it up immediately instead of showing the confirm screen.
    getSyncStatus()
      .then((status) => {
        if (!mountedRef.current) return
        applyStatus(status)
      })
      .catch(() => {
        // Before the user starts onboarding there may be no sync status yet.
      })

    return () => {
      mountedRef.current = false
    }
  }, [applyStatus])

  useEffect(() => {
    if (!loading) return undefined

    const intervalId = window.setInterval(() => {
      void checkSyncStatus()
    }, POLL_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [checkSyncStatus, loading])

  const handleSubmit = () => {
    void startSync()
  }

  const handleRetry = () => {
    // Explicit retry resets the silent-resume budget.
    autoResumeRef.current = 0
    void startSync()
  }

  const showProgress = started || loading || syncStatus?.state === 'running' || syncStatus?.state === 'error'

  if (showProgress) {
    return (
      <InitializationProgress
        status={syncStatus}
        error={error}
        retrying={loading}
        onRetry={handleRetry}
        steps={steps}
        syncFullHistory={isFullSync}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">确认并开始</h2>
        <p className="text-sm text-text-muted mt-1">
          {isFullSync ? '确认信息后，我们会同步你的完整历史训练数据' : '确认信息后，我们会快速同步你的健康数据'}
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={handleRetry}
            className="text-xs font-medium text-red-400 underline underline-offset-2 hover:text-red-300 shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {/* Summary card */}
      <div className="bg-bg-base rounded-xl border border-border-subtle p-4 space-y-3 text-sm">
        <Row label="显示名称" value={profile.display_name} />
        <Row label="出生日期" value={profile.dob} />
        <Row label="性别" value={profile.sex === 'male' ? '男' : '女'} />
        <Row label="身高" value={`${profile.height_cm} cm`} />
        <Row label="体重" value={`${profile.weight_kg} kg`} />
      </div>

      <div className="rounded-xl border border-border-subtle bg-accent-green/5 p-4">
        <p className="text-sm text-text-primary font-medium">接下来会做什么？</p>
        <ul className="mt-2 space-y-1 text-xs text-text-muted">
          {isFullSync ? (
            <>
              <li>1. 同步你的完整历史训练与健康数据（可能需要几分钟）</li>
              <li>2. 校准训练区间、计算训练负荷与能力模型</li>
              <li>3. 同步完成后进入训练仪表盘</li>
            </>
          ) : (
            <>
              <li>1. 快速同步近期健康数据（约 10 秒）</li>
              <li>2. 进入主页浏览你的训练仪表盘</li>
              <li>3. 稍后在「训练计划」页面设置比赛目标并同步完整历史数据</li>
            </>
          )}
        </ul>
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <span className="w-4 h-4 border-2 border-bg-base/30 border-t-bg-base rounded-full animate-spin" />
            正在同步...
          </>
        ) : (
          '开始使用 STRIDE'
        )}
      </button>
    </div>
  )
}

type ProgressStep = { title: string; description: string; phases: string[] }

function InitializationProgress({
  status,
  error,
  retrying,
  onRetry,
  steps,
  syncFullHistory,
}: {
  status: SyncStatus | null
  error: string
  retrying: boolean
  onRetry: () => void
  steps: ProgressStep[]
  syncFullHistory: boolean
}) {
  const failed = Boolean(error) || status?.state === 'error'
  const progress = status?.progress ?? null
  const phase = failed ? progress?.failed_phase ?? progress?.phase ?? 'queued' : progress?.phase ?? 'queued'
  const activeStepIndex = getActiveStepIndex(phase, steps)
  const percent = clampPercent(failed ? progress?.percent ?? 0 : progress?.percent ?? 6)
  const message = failed
    ? error || status?.error || '同步失败，请重试'
    : progress?.message ?? (syncFullHistory ? '正在同步历史数据' : '正在同步健康数据')

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">
          {failed ? '同步遇到问题' : syncFullHistory ? '正在同步历史数据' : '正在同步健康数据'}
        </h2>
        <p className="text-sm text-text-muted mt-1">
          {syncFullHistory ? '正在同步完整历史数据，可能需要几分钟，请保持页面打开。' : '仅同步近期健康指标，很快就好。'}
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-base p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-text-primary">{message}</p>
            <p className="text-xs text-text-muted mt-1">
              {failed ? '请检查手表账号登录状态或网络后重试。' : '请稍候片刻。'}
            </p>
          </div>
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

        <ProgressStats progress={progress} syncFullHistory={syncFullHistory} />
      </div>

      <div className="space-y-3">
        {steps.map((step, index) => {
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
          disabled={retrying}
          className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer"
        >
          {retrying ? '正在重试...' : '重新同步'}
        </button>
      )}
    </div>
  )
}

function ProgressStats({ progress, syncFullHistory }: { progress: SyncProgress | null; syncFullHistory: boolean }) {
  if (!progress) return null

  // During the activity-details phase the sync reports current/total (e.g.
  // 59/783) — the only place with a live count for the full-history sync.
  const detailCount =
    syncFullHistory && typeof progress.current === 'number' && typeof progress.total === 'number' && progress.total > 0
      ? `${progress.current}/${progress.total}`
      : null

  const hasActivities = typeof progress.synced_activities === 'number'
  const hasHealth = typeof progress.synced_health === 'number'

  if (!detailCount && !hasActivities && !hasHealth) return null

  return (
    <div className="grid grid-cols-2 gap-3 pt-1">
      {detailCount && <ProgressStat label="训练详情" value={detailCount} />}
      {hasActivities && <ProgressStat label="训练记录" value={`${progress.synced_activities}`} />}
      {hasHealth && <ProgressStat label="健康天数" value={`${progress.synced_health}`} />}
    </div>
  )
}

function ProgressStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card px-3 py-2">
      <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-sm font-semibold text-text-primary mt-1">{value}</p>
    </div>
  )
}

function StepDot({ state }: { state: 'done' | 'active' | 'pending' | 'error' }) {
  if (state === 'done') {
    return (
      <span className="flex w-5 h-5 items-center justify-center rounded-full bg-accent-green text-bg-base text-xs">
        ✓
      </span>
    )
  }

  if (state === 'error') {
    return (
      <span className="flex w-5 h-5 items-center justify-center rounded-full bg-accent-red text-bg-base text-xs">
        !
      </span>
    )
  }

  if (state === 'active') {
    return (
      <span className="flex w-5 h-5 items-center justify-center rounded-full border-2 border-accent-green">
        <span className="w-2 h-2 rounded-full bg-accent-green animate-pulse" />
      </span>
    )
  }

  return <span className="block w-5 h-5 rounded-full border border-border-subtle bg-bg-base" />
}

function getActiveStepIndex(phase: string, steps: ProgressStep[]) {
  const index = steps.findIndex((step) => step.phases.includes(phase))
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-xs font-mono text-text-muted uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-text-primary text-right">{value}</span>
    </div>
  )
}
