import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { postOnboardingComplete, getSyncStatus, type ProfileIn, type SyncStatus } from '../../api'

interface Props {
  profile: ProfileIn
}

const MAX_POLL_ATTEMPTS = 200 // 200 * 3s = 10 min
const POLL_INTERVAL_MS = 3000

const PROGRESS_STEPS = [
  {
    title: '提交任务',
    description: '保存资料并启动后台同步',
    phases: ['queued', 'connecting'],
  },
  {
    title: '扫描训练',
    description: '查找手表训练记录',
    phases: ['activities_scan'],
  },
  {
    title: '同步详情',
    description: '下载配速、心率、分段和圈数据',
    phases: ['activity_details', 'activity_save', 'commentary', 'ability', 'activities_done'],
  },
  {
    title: '健康指标',
    description: '同步疲劳、训练负荷和仪表盘数据',
    phases: ['health', 'dashboard', 'health_done'],
  },
  {
    title: '完成初始化',
    description: '保存结果并进入训练仪表盘',
    phases: ['finalizing', 'complete'],
  },
]

export default function SubmitStep({ profile }: Props) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [started, setStarted] = useState(false)
  const [error, setError] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const pollAttemptRef = useRef(0)
  const mountedRef = useRef(false)

  const applyStatus = useCallback((status: SyncStatus) => {
    setSyncStatus(status)

    if (status.state === 'done') {
      setLoading(false)
      navigate('/health')
      return
    }

    if (status.state === 'error') {
      setError(status.error || '同步出错，请重试')
      setLoading(false)
      setStarted(true)
      return
    }

    if (status.state === 'running') {
      setError('')
      setStarted(true)
      setLoading(true)
    }
  }, [navigate])

  const checkSyncStatus = useCallback(async () => {
    try {
      const status = await getSyncStatus()
      if (!mountedRef.current) return

      pollAttemptRef.current += 1
      applyStatus(status)

      if (status.state === 'running' && pollAttemptRef.current >= MAX_POLL_ATTEMPTS) {
        setError('同步超时，请刷新页面查看状态')
        setLoading(false)
      }
    } catch {
      if (!mountedRef.current) return

      pollAttemptRef.current += 1
      if (pollAttemptRef.current >= MAX_POLL_ATTEMPTS) {
        setError('无法获取同步状态，请刷新页面')
        setLoading(false)
      }
    }
  }, [applyStatus])

  useEffect(() => {
    mountedRef.current = true

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

  const handleSubmit = async () => {
    setError('')
    setStarted(true)
    setLoading(true)
    pollAttemptRef.current = 0

    try {
      const { ok, data } = await postOnboardingComplete()
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
          message: '已提交初始化任务，等待后台同步启动',
          percent: 0,
        },
      })
    } catch {
      setError('请求失败，请重试')
      setLoading(false)
    }
  }

  const handleRetry = () => {
    setError('')
    handleSubmit()
  }

  const showProgress = started || loading || syncStatus?.state === 'running' || syncStatus?.state === 'error'

  if (showProgress) {
    return (
      <InitializationProgress
        status={syncStatus}
        error={error}
        retrying={loading}
        onRetry={handleRetry}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">确认并提交</h2>
        <p className="text-sm text-text-muted mt-1">确认以下信息后开始初始化你的训练仪表盘</p>
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
        <div className="border-t border-border-subtle pt-3 space-y-3">
          <Row label="目标比赛" value={profile.target_race} />
          <Row label="目标距离" value={profile.target_distance} />
          <Row label="比赛日期" value={profile.target_race_date} />
          <Row label="目标成绩" value={profile.target_time} />
        </div>
        {profile.weekly_mileage_km != null && (
          <div className="border-t border-border-subtle pt-3">
            <Row label="周跑量" value={`${profile.weekly_mileage_km} km`} />
          </div>
        )}
        {profile.pbs && Object.keys(profile.pbs).length > 0 && (
          <div className="border-t border-border-subtle pt-3 space-y-3">
            {Object.entries(profile.pbs).map(([dist, time]) => (
              <Row key={dist} label={`${dist.toUpperCase()} PB`} value={time} />
            ))}
          </div>
        )}
        {profile.constraints && (
          <div className="border-t border-border-subtle pt-3">
            <Row label="限制条件" value={profile.constraints} />
          </div>
        )}
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading}
        className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <span className="w-4 h-4 border-2 border-bg-base/30 border-t-bg-base rounded-full animate-spin" />
            正在初始化...
          </>
        ) : (
          '开始使用 STRIDE'
        )}
      </button>
    </div>
  )
}

function InitializationProgress({
  status,
  error,
  retrying,
  onRetry,
}: {
  status: SyncStatus | null
  error: string
  retrying: boolean
  onRetry: () => void
}) {
  const failed = Boolean(error) || status?.state === 'error'
  const progress = status?.progress ?? null
  const phase = failed ? progress?.failed_phase ?? progress?.phase ?? 'queued' : progress?.phase ?? 'queued'
  const activeStepIndex = getActiveStepIndex(phase)
  const percent = clampPercent(failed ? progress?.percent ?? 0 : progress?.percent ?? 6)
  const message = failed
    ? error || status?.error || '初始化失败，请重试'
    : progress?.message ?? '正在启动首次同步，请稍候'
  const current = progress?.current
  const total = progress?.total
  const showCurrentTotal = typeof current === 'number' && typeof total === 'number' && total > 0

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">
          {failed ? '初始化遇到问题' : '正在初始化 STRIDE'}
        </h2>
        <p className="text-sm text-text-muted mt-1">
          首次同步需要下载历史训练和健康指标，耗时较长是正常现象。完成后会自动进入身体指标页。
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-base p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-text-primary">{message}</p>
            <p className="text-xs text-text-muted mt-1">
              {failed ? '请检查手表账号登录状态或网络后重试。' : '请保持页面打开，同步会在后台继续执行。'}
            </p>
          </div>
          {!failed && (
            <span className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin shrink-0" />
          )}
        </div>

        <div>
          <div className="flex justify-between text-xs font-mono text-text-muted mb-2">
            <span>初始化进度</span>
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
              <ProgressStat label="当前批次" value={`${current}/${total}`} />
            )}
            {typeof progress?.synced_activities === 'number' && (
              <ProgressStat label="活动写入" value={`${progress.synced_activities}`} />
            )}
            {typeof progress?.synced_health === 'number' && (
              <ProgressStat label="健康天数" value={`${progress.synced_health}`} />
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
          disabled={retrying}
          className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer"
        >
          {retrying ? '正在重试...' : '重新开始初始化'}
        </button>
      )}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-xs font-mono text-text-muted uppercase tracking-wider shrink-0">{label}</span>
      <span className="text-text-primary text-right">{value}</span>
    </div>
  )
}
