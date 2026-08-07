import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getPipelineRun,
  postOnboardingComplete,
  triggerSync,
  type PipelineRun,
} from '../../api'

interface Props {
  userId: string
}

const POLL_INTERVAL_MS = 2000
const ONBOARDING_RUN_KEY_PREFIX = 'stride:onboarding-run:'
const ONBOARDING_START_KEY_PREFIX = 'stride:onboarding-start-key:'

type RunView = 'starting' | 'running' | 'failed' | 'done'

type StageState = 'pending' | 'active' | 'done' | 'failed'

const STAGES = [
  { key: 'sync', title: '同步数据', description: '导入手表中的训练与健康数据' },
  { key: 'calibration', title: '校准训练基线', description: '建立个人心率、配速与训练区间参考' },
  { key: 'compute', title: '计算训练指标', description: '生成训练负荷与能力指标' },
] as const

function storageKey(userId: string) {
  return `${ONBOARDING_RUN_KEY_PREFIX}${userId}`
}

function startKeyStorageKey(userId: string) {
  return `${ONBOARDING_START_KEY_PREFIX}${userId}`
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function stageForStep(name: string | undefined): number {
  const normalized = name?.toLowerCase() ?? ''
  if (normalized.includes('calibration')) return 1
  if (normalized.includes('compute')) return 2
  return 0
}

function stageState(run: PipelineRun | null, stageIndex: number): StageState {
  if (!run) return stageIndex === 0 ? 'active' : 'pending'
  if (run.status === 'done') return 'done'

  const source = run.steps.find((step) => stageForStep(step.name) === stageIndex)
  const sourceStatus = source?.status.toLowerCase()
  const currentStage = stageForStep(run.steps[run.current_step]?.name)

  if (sourceStatus === 'failed' || (run.status === 'failed' && currentStage === stageIndex)) return 'failed'
  if (sourceStatus === 'done' || sourceStatus === 'completed' || stageIndex < currentStage) return 'done'
  if (sourceStatus === 'running' || stageIndex === currentStage) return 'active'
  return 'pending'
}

function stateLabel(state: StageState) {
  switch (state) {
    case 'done': return '已完成'
    case 'active': return '进行中'
    case 'failed': return '失败'
    default: return '未开始'
  }
}

export default function SubmitStep({ userId }: Props) {
  const navigate = useNavigate()
  const [run, setRun] = useState<PipelineRun | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [view, setView] = useState<RunView>('starting')
  const [error, setError] = useState('')
  const [finalizing, setFinalizing] = useState(false)
  const [finalizeError, setFinalizeError] = useState('')
  const mountedRef = useRef(false)
  const userIdRef = useRef(userId)
  const generationRef = useRef(0)
  const runIdRef = useRef<string | null>(null)
  const startInFlightRef = useRef(false)

  const clearSavedRun = useCallback((forUserId = userId) => {
    localStorage.removeItem(storageKey(forUserId))
  }, [userId])

  const clearStartKey = useCallback((forUserId = userId) => {
    localStorage.removeItem(startKeyStorageKey(forUserId))
  }, [userId])

  const applyRun = useCallback((nextRun: PipelineRun, expectedUserId: string, generation: number) => {
    if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation || nextRun.run_id !== runIdRef.current) return
    setActiveRunId(nextRun.run_id)
    setRun(nextRun)
    if (nextRun.status === 'done') {
      setView('done')
      setError('')
    } else if (nextRun.status === 'failed') {
      setView('failed')
      setError(nextRun.error_message || '数据同步未完成，请重试。')
    } else {
      setView('running')
      setError('')
    }
  }, [])

  const refreshRun = useCallback(async (runId: string, expectedUserId: string, generation: number) => {
    try {
      const nextRun = await getPipelineRun(runId)
      if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation || runId !== runIdRef.current) return true
      // A saved browser pointer is only valid for an onboarding full-sync run.
      // Ownership is enforced by the server before this response is returned.
      if (nextRun.pipeline_name !== 'onboarding') return false
      applyRun(nextRun, expectedUserId, generation)
      return true
    } catch {
      return false
    }
  }, [applyRun])

  const startNewRun = useCallback(async (expectedUserId = userId, generation = generationRef.current) => {
    if (startInFlightRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return
    startInFlightRef.current = true
    runIdRef.current = null
    setActiveRunId(null)
    setRun(null)
    setView('starting')
    setError('')
    setFinalizeError('')

    const startKey = localStorage.getItem(startKeyStorageKey(expectedUserId)) || createIdempotencyKey()
    localStorage.setItem(startKeyStorageKey(expectedUserId), startKey)
    try {
      const result = await triggerSync(expectedUserId, { full: true, idempotencyKey: startKey })
      if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return
      if (!result.ok || !result.data.run_id) {
        setView('failed')
        setError(result.data.error || '无法启动数据同步，请重试。')
        return
      }

      const runId = result.data.run_id
      runIdRef.current = runId
      localStorage.setItem(storageKey(expectedUserId), runId)
      clearStartKey(expectedUserId)
      setActiveRunId(runId)
      setView('running')
      void refreshRun(runId, expectedUserId, generation)
    } catch {
      if (mountedRef.current && userIdRef.current === expectedUserId && generationRef.current === generation) {
        setView('failed')
        setError('无法启动数据同步，请检查网络后重试。')
      }
    } finally {
      if (userIdRef.current === expectedUserId && generationRef.current === generation) startInFlightRef.current = false
    }
  }, [clearStartKey, refreshRun, userId])

  useEffect(() => {
    mountedRef.current = true
    userIdRef.current = userId
    const generation = ++generationRef.current
    startInFlightRef.current = false
    runIdRef.current = null
    setActiveRunId(null)
    setRun(null)
    setView('starting')
    setError('')
    setFinalizing(false)
    setFinalizeError('')

    const savedRunId = localStorage.getItem(storageKey(userId))
    if (!savedRunId) {
      // Defer the first state update until after this subscription effect has
      // completed; subsequent retry state changes happen in event callbacks.
      void Promise.resolve().then(() => startNewRun(userId, generation))
    } else {
      runIdRef.current = savedRunId
      // Keep recovery validation asynchronous; browser storage does not confer
      // authority over the run and the server response populates UI state.
      void refreshRun(savedRunId, userId, generation).then((valid) => {
        if (!mountedRef.current || userIdRef.current !== userId || generationRef.current !== generation || valid) return
        // Browser storage is only a recovery pointer. The server decides whether
        // a run exists and belongs to the current user.
        clearSavedRun(userId)
        runIdRef.current = null
        setActiveRunId(null)
        void startNewRun(userId, generation)
      })
    }

    return () => {
      mountedRef.current = false
    }
  }, [clearSavedRun, refreshRun, startNewRun, userId])

  useEffect(() => {
    if (!activeRunId || (run?.status !== 'queued' && run?.status !== 'running')) return undefined
    const expectedUserId = userId
    const generation = generationRef.current
    const interval = window.setInterval(() => {
      void refreshRun(activeRunId, expectedUserId, generation)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeRunId, refreshRun, run?.status, userId])

  const retry = () => {
    clearSavedRun()
    runIdRef.current = null
    setActiveRunId(null)
    void startNewRun(userId, generationRef.current)
  }

  const finalize = async () => {
    const expectedUserId = userId
    const generation = generationRef.current
    const completedRunId = runIdRef.current
    if (!completedRunId || finalizing) return
    setFinalizing(true)
    setFinalizeError('')
    try {
      const result = await postOnboardingComplete(completedRunId)
      if (!mountedRef.current || userIdRef.current !== expectedUserId || generationRef.current !== generation) return
      if (!result.ok) {
        setFinalizeError(result.data.error || result.data.detail || '无法完成初始化，请重试。')
        return
      }
      clearSavedRun(expectedUserId)
      clearStartKey(expectedUserId)
      navigate('/', { replace: true })
    } catch {
      if (mountedRef.current && userIdRef.current === expectedUserId && generationRef.current === generation) {
        setFinalizeError('无法完成初始化，请检查网络后重试。')
      }
    } finally {
      if (mountedRef.current && userIdRef.current === expectedUserId && generationRef.current === generation) setFinalizing(false)
    }
  }

  const failed = view === 'failed'
  const done = view === 'done'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">
          {done ? '数据准备完成' : failed ? '数据同步遇到问题' : '正在准备你的训练数据'}
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          {done
            ? '确认进入 STRIDE 后即可开始查看你的训练数据。'
            : failed
              ? '未完成的数据不会影响你的账户设置。'
              : '首次同步会导入历史训练，并完成基础训练指标计算。'}
        </p>
      </div>

      <ol className="space-y-3" aria-label="数据准备进度">
        {STAGES.map((stage, index) => {
          const state = failed && !run ? (index === 0 ? 'failed' : 'pending') : stageState(run, index)
          return (
            <li key={stage.key} className="flex gap-3 rounded-lg border border-border-subtle bg-bg-base p-4">
              <StageIcon state={state} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">
                  {stage.title} <span className="text-text-muted">· {stateLabel(state)}</span>
                </p>
                <p className="mt-0.5 text-xs text-text-muted">{stage.description}</p>
              </div>
            </li>
          )
        })}
      </ol>

      {failed && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error || '数据同步未完成，请重试。'}
        </div>
      )}

      {done && finalizeError && (
        <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {finalizeError}
        </div>
      )}

      {failed && (
        <button
          type="button"
          onClick={retry}
          className="w-full rounded-lg bg-accent-green px-4 py-2 text-sm font-medium text-bg-base transition-colors hover:bg-accent-green/90"
        >
          重新同步
        </button>
      )}

      {done && (
        <button
          type="button"
          onClick={() => void finalize()}
          disabled={finalizing}
          className="w-full rounded-lg bg-accent-green px-4 py-2 text-sm font-medium text-bg-base transition-colors hover:bg-accent-green/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {finalizing ? '正在进入 STRIDE...' : 'Enter STRIDE'}
        </button>
      )}
    </div>
  )
}

function StageIcon({ state }: { state: StageState }) {
  const icon = state === 'done' ? '✓' : state === 'failed' ? '!' : state === 'active' ? '•' : '○'
  const color = state === 'failed'
    ? 'border-red-500 text-red-400'
    : state === 'done'
      ? 'border-accent-green bg-accent-green text-bg-base'
      : state === 'active'
        ? 'border-accent-green text-accent-green'
        : 'border-border-subtle text-text-muted'
  return <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${color}`}>{icon}</span>
}
