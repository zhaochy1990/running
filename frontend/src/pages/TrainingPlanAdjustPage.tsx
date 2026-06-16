import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  applyMasterPlanAdjustDiff,
  getActivities,
  getCurrentMasterPlan,
  getHealth,
  getHrv,
  getMyProfile,
  getPMC,
  getPlanDays,
  getStrideZones,
  getTrainingPlan,
  getWeeks,
  sendMasterPlanAdjustMessage,
  type Activity,
  type MasterPlan,
  type MasterPlanAffectedWeek,
  type MasterPlanDiff,
  type MasterPlanDiffOp,
  type MyProfile,
  type PlanDay,
  type StrideZonesResponse,
  type TrainingPlan,
} from '../api'
import { shanghaiDate, shanghaiToday } from '../lib/shanghai'
import { useUser } from '../UserContextValue'

type FlowStep = 'intent' | 'body' | 'focus' | 'sessions' | 'preview'
type PreviewMode = 'current' | 'new'

interface FlowAnswers {
  intent?: string
  body?: string
  focus?: string
  sessions?: string
}

interface ScanRow {
  id: string
  label: string
  value: string
  detail?: string
  tone?: 'ok' | 'warn' | 'neutral'
}

interface ScanState {
  rows: ScanRow[]
  paceZone: string
  hrZone: string
  paceRows: ZoneRow[]
  hrRows: ZoneRow[]
}

interface DisplayPhase {
  id: string
  name: string
  start: string
  end: string
  focus: string
  low: number | null
  high: number | null
  weekStart: number
  weekEnd: number
  weekCount: number
  keySessions: string[]
  changed?: boolean
}

interface PlanMileageBar {
  week: number
  km: number | null
  phaseIndex: number
  changed: boolean
  heightPct: number
  title: string
}

interface TargetProfile {
  raceName: string
  distance: string
  raceDate: string
  targetTime: string
}

const FLOW_COPY: Record<FlowStep, { question: string; options: string[] }> = {
  intent: {
    question: '这次想怎么调整训练计划？',
    options: ['减量缓冲一段时间', '顺延训练', '继续加量 / 强化能力'],
  },
  body: {
    question: '身体哪里最需要保护？',
    options: ['跟腱 / 小腿', '膝关节', '全身疲劳'],
  },
  focus: {
    question: '这次重点想建立什么？',
    options: ['专项能力', '有氧耐力', '力量与跑姿'],
  },
  sessions: {
    question: '接下来一周能稳定安排几次训练？',
    options: ['3 次跑步', '4 次跑步', '5 次跑步'],
  },
  preview: {
    question: '新计划已经生成在左侧。',
    options: [],
  },
}

const PHASE_COLORS = ['#00a85a', '#0097a7', '#e68a00', '#7c4dff', '#d32f2f']

export default function TrainingPlanAdjustPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const [masterPlan, setMasterPlan] = useState<MasterPlan | null>(null)
  const [fallbackPlan, setFallbackPlan] = useState<TrainingPlan | null>(null)
  const [profile, setProfile] = useState<MyProfile | null>(null)
  const [loadingPlan, setLoadingPlan] = useState(true)
  const [scanLoading, setScanLoading] = useState(true)
  const [scan, setScan] = useState<ScanState>(() => emptyScan())
  const [answers, setAnswers] = useState<FlowAnswers>({})
  const [step, setStep] = useState<FlowStep>('intent')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('current')
  const [diff, setDiff] = useState<MasterPlanDiff | null>(null)
  const [selectedOpIds, setSelectedOpIds] = useState<Set<string>>(new Set())
  const [adjustLoading, setAdjustLoading] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  const [applyLoading, setApplyLoading] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [affectedWeeks, setAffectedWeeks] = useState<MasterPlanAffectedWeek[]>([])

  const loadPlan = useCallback(() => {
    if (!user) return undefined
    let cancelled = false
    setLoadingPlan(true)
    Promise.all([
      getCurrentMasterPlan().catch(() => null),
      getTrainingPlan(user).catch(() => null),
      getMyProfile().catch(() => null),
    ]).then(([master, fallback, profileData]) => {
      if (cancelled) return
      setMasterPlan(master)
      setFallbackPlan(fallback)
      setProfile(profileData)
    }).finally(() => {
      if (!cancelled) setLoadingPlan(false)
    })
    return () => { cancelled = true }
  }, [user])

  const loadScan = useCallback(() => {
    if (!user) return undefined
    let cancelled = false
    setScanLoading(true)
    const today = shanghaiToday()
    const from = addDays(today, -13)

    async function run() {
      const activitiesP = getActivities(user, { dateFrom: from, dateTo: today, limit: 20, offset: 0 }).catch(() => null)
      const healthP = getHealth(user, 14).catch(() => null)
      const hrvP = getHrv(user, 14).catch(() => null)
      const pmcP = getPMC(user, 30).catch(() => null)
      const zonesP = getStrideZones(user).catch(() => null)
      const weeks = await getWeeks(user).catch(() => null)
      const currentWeek = findCurrentWeek(weeks?.weeks ?? [], today)
      const planDaysP = currentWeek
        ? getPlanDays(user, currentWeek.date_from, currentWeek.date_to).catch(() => null)
        : Promise.resolve(null)
      const [activities, health, hrv, pmc, zones, planDays] = await Promise.all([
        activitiesP,
        healthP,
        hrvP,
        pmcP,
        zonesP,
        planDaysP,
      ])
      if (cancelled) return
      setScan(buildScanState({
        activities: activities?.activities ?? null,
        health,
        hrv,
        pmc,
        zones,
        planDays: planDays?.days ?? null,
        currentWeek,
      }))
    }

    run().finally(() => {
      if (!cancelled) setScanLoading(false)
    })
    return () => { cancelled = true }
  }, [user])

  useEffect(() => loadPlan(), [loadPlan])
  useEffect(() => loadScan(), [loadScan])

  const currentPhases = useMemo(() => toDisplayPhases(masterPlan, fallbackPlan), [masterPlan, fallbackPlan])
  const previewPhases = useMemo(() => buildPreviewPhases(currentPhases, answers), [currentPhases, answers])
  const targetProfile = useMemo(() => readTargetProfile(profile), [profile])
  const previewReady = step === 'preview'

  const handleAnswer = (answer: string) => {
    const nextAnswers = { ...answers }
    if (step === 'intent') {
      nextAnswers.intent = answer
      setAnswers(nextAnswers)
      setStep(answer.includes('继续') ? 'focus' : 'body')
      return
    }
    if (step === 'body') {
      nextAnswers.body = answer
      setAnswers(nextAnswers)
      setStep('sessions')
      return
    }
    if (step === 'focus') {
      nextAnswers.focus = answer
      setAnswers(nextAnswers)
      setStep('sessions')
      return
    }
    if (step === 'sessions') {
      nextAnswers.sessions = answer
      setAnswers(nextAnswers)
      setStep('preview')
      setPreviewMode('new')
      void requestAdjustDiff(nextAnswers)
    }
  }

  const restartFlow = () => {
    setAnswers({})
    setStep('intent')
    setPreviewMode('current')
    setDiff(null)
    setSelectedOpIds(new Set())
    setAdjustError(null)
    setApplyError(null)
    setAffectedWeeks([])
  }

  const requestAdjustDiff = async (nextAnswers: FlowAnswers) => {
    setAdjustError(null)
    setDiff(null)
    setSelectedOpIds(new Set())
    if (!masterPlan?.plan_id) return
    setAdjustLoading(true)
    try {
      const response = await sendMasterPlanAdjustMessage(
        masterPlan.plan_id,
        composeAdjustMessage(nextAnswers, scan),
        [],
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const nextDiff = response.data.diff
      setDiff(nextDiff)
      setSelectedOpIds(new Set(nextDiff?.ops.map((op) => op.id) ?? []))
    } catch (err) {
      setAdjustError(err instanceof Error ? err.message : '调整建议生成失败')
    } finally {
      setAdjustLoading(false)
    }
  }

  const toggleOp = (opId: string) => {
    setSelectedOpIds((prev) => {
      const next = new Set(prev)
      if (next.has(opId)) next.delete(opId)
      else next.add(opId)
      return next
    })
  }

  const applyDiff = async () => {
    if (!masterPlan?.plan_id || !diff?.diff_id) return
    setApplyLoading(true)
    setApplyError(null)
    try {
      const opIds = diff.ops.map((op) => op.id).filter((id) => selectedOpIds.has(id))
      const response = await applyMasterPlanAdjustDiff(
        masterPlan.plan_id,
        diff.diff_id,
        opIds,
        composeChangeReason(answers),
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setAffectedWeeks(response.data.affected_weeks ?? [])
      setDiff(null)
      setSelectedOpIds(new Set())
      loadPlan()
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : '采用失败')
    } finally {
      setApplyLoading(false)
    }
  }

  if (loadingPlan) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <div className="mb-6">
        <button type="button" onClick={() => navigate('/plan')} className="pa-back">
          <BackIcon />
          返回训练计划
        </button>
        <p className="font-mono text-[10px] text-accent-green tracking-[0.14em] font-semibold uppercase mt-3 mb-1.5">调整 / 重新生成训练计划</p>
        <h1 className="text-xl sm:text-2xl font-semibold leading-[1.15] text-text-primary m-0">告诉 STRIDE 发生了什么</h1>
        <p className="text-[13px] text-text-secondary mt-1.5 max-w-[540px]">STRIDE 会先查看你的训练记录与身体状态，再结合你的反馈重新规划。两步都准备好后即可开始。</p>
      </div>

      <div className="pa-split">
        <PlanReferencePanel
          currentPhases={currentPhases}
          previewPhases={previewPhases}
          previewReady={previewReady}
          mode={previewMode}
          onModeChange={setPreviewMode}
          masterPlan={masterPlan}
          fallbackPlan={fallbackPlan}
          targetProfile={targetProfile}
          summary={buildAnswerSummary(answers)}
        />

        <div className="pa-flow">
          <ScanPanel scan={scan} loading={scanLoading} />
          <GuidedFlow
            answers={answers}
            step={step}
            onAnswer={handleAnswer}
            previewReady={previewReady}
            adjustLoading={adjustLoading}
            adjustError={adjustError}
            diff={diff}
            selectedOpIds={selectedOpIds}
            onToggleOp={toggleOp}
            onRetryAdjust={() => requestAdjustDiff(answers)}
            onRevise={restartFlow}
            onApply={applyDiff}
            applyLoading={applyLoading}
            applyError={applyError}
            affectedWeeks={affectedWeeks}
            hasPlanId={Boolean(masterPlan?.plan_id)}
          />
        </div>
      </div>
    </div>
  )
}

function PlanReferencePanel({
  currentPhases,
  previewPhases,
  previewReady,
  mode,
  onModeChange,
  masterPlan,
  fallbackPlan,
  targetProfile,
  summary,
}: {
  currentPhases: DisplayPhase[]
  previewPhases: DisplayPhase[]
  previewReady: boolean
  mode: PreviewMode
  onModeChange: (mode: PreviewMode) => void
  masterPlan: MasterPlan | null
  fallbackPlan: TrainingPlan | null
  targetProfile: TargetProfile
  summary: string
}) {
  const isNew = previewReady && mode === 'new'
  return (
    <aside className="pa-current" id="pa-leftplan">
      {previewReady && (
        <div className="pa-planswitch">
          <button type="button" data-plan="cur" className={!isNew ? 'active' : ''} onClick={() => onModeChange('current')}>当前计划</button>
          <button type="button" data-plan="new" className={isNew ? 'active' : ''} onClick={() => onModeChange('new')}>新计划</button>
        </div>
      )}
      {isNew ? (
        <PlanReferenceView
          kind="new"
          phases={previewPhases}
          masterPlan={masterPlan}
          fallbackPlan={fallbackPlan}
          targetProfile={targetProfile}
          summary={summary}
        />
      ) : (
        <PlanReferenceView
          kind="current"
          phases={currentPhases}
          masterPlan={masterPlan}
          fallbackPlan={fallbackPlan}
          targetProfile={targetProfile}
          summary={summary}
        />
      )}
    </aside>
  )
}

function PlanReferenceView({
  kind,
  phases,
  masterPlan,
  fallbackPlan,
  targetProfile,
  summary,
}: {
  kind: 'current' | 'new'
  phases: DisplayPhase[]
  masterPlan: MasterPlan | null
  fallbackPlan: TrainingPlan | null
  targetProfile: TargetProfile
  summary: string
}) {
  const isNew = kind === 'new'
  const totalWeeks = planTotalWeeks(masterPlan, phases)
  return (
    <div className="pa-planview">
      <div className="pa-chead">
        <div className={`pa-ctag ${isNew ? 'newt' : ''}`}>{isNew ? '新计划 · 已生成' : '当前计划'}</div>
        <div className="pa-ctitle">{planReferenceTitle(masterPlan, phases, targetProfile)}{isNew ? '（已调整）' : ''}</div>
        <div className="pa-cmeta">{planMeta(masterPlan, fallbackPlan, isNew)}</div>
      </div>
      <div className="pa-cbody">
        {isNew && <PlanChanges summary={summary} />}
        <RaceCard unchanged={isNew} target={targetProfile} masterPlan={masterPlan} />
        <PlanMileageCurve phases={phases} totalWeeks={totalWeeks} isNew={isNew} />
        <div>
          <div className="pa-cl">阶段划分 · 起止与周数</div>
          <div className="pa-pdetail">
            {phases.length > 0 ? phases.map((phase, index) => (
              <PhaseDetailCard
                key={phase.id}
                phase={phase}
                index={index}
                isCurrent={phase.id === masterPlan?.current_phase_id || (!masterPlan?.current_phase_id && index === 0)}
                changed={Boolean(isNew && phase.changed)}
              />
            )) : (
              <div className="rounded-xl border border-dashed border-border-subtle p-6 text-sm text-text-muted text-center">暂无计划阶段</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function PlanChanges({ summary }: { summary: string }) {
  return (
    <div className="pa-changes">
      <div className="ch-l">本次调整 · 3 处</div>
      <div className="pa-chrow">
        <PulseMiniIcon className="ic" />
        <div className="tx"><b>{summary || '本周起调整训练负荷'}</b>，周量和强度按当前反馈重新排序。<span className="why">— 基于身体与计划扫描</span></div>
      </div>
      <div className="pa-chrow">
        <ArrowMiniIcon className="ic" />
        <div className="tx">关键课不强行补回，优先顺延到恢复后的第 1 周。</div>
      </div>
      <div className="pa-chrow">
        <PlusCircleMiniIcon className="ic" />
        <div className="tx"><b>目标比赛日期不变</b>，只调整当前阶段和后续阶段分配。</div>
      </div>
    </div>
  )
}

function RaceCard({ unchanged, target, masterPlan }: { unchanged: boolean; target: TargetProfile; masterPlan: MasterPlan | null }) {
  const raceName = target.raceName || '目标比赛暂无数据'
  const raceDate = target.raceDate || masterPlan?.end_date || ''
  const weeks = raceDate ? weeksUntil(raceDate) : null
  const days = raceDate ? daysUntil(raceDate) : null
  const distance = target.distance || '距离暂无数据'
  const targetTime = target.targetTime ? ` · 目标 ${target.targetTime}` : ''
  return (
    <div className="pa-race">
      <div className="top">
        <div className="rl">目标比赛{unchanged ? ' · 不变' : ''}</div>
        <div className="rn">{raceName}</div>
        <div className="rd">{distance}{raceDate ? ` · ${formatSlashDate(raceDate)}` : ' · 日期暂无数据'}{targetTime}</div>
      </div>
      <div className="pa-cdown">
        <div className="c"><div className="n"><b>{weeks ?? '--'}</b></div><div className="u">周 后开赛</div></div>
        <div className="c"><div className="n">{days ?? '--'}</div><div className="u">天 倒计时</div></div>
      </div>
    </div>
  )
}

function PlanMileageCurve({ phases, totalWeeks, isNew }: { phases: DisplayPhase[]; totalWeeks: number; isNew: boolean }) {
  const bars = buildMileageBars(phases, totalWeeks)
  const peak = findPeakBar(bars)
  return (
    <div>
      <div className="pa-cl">全程周量曲线 · {totalWeeks || bars.length || '--'} 周 <span className="sp">· {isNew ? '预览调整 · ' : ''}{peak ? `峰值 ${peak.km}km (W${padWeek(peak.week)})` : '暂无周量数据'}</span></div>
      <div className="pa-cbars">
        {bars.length > 0 ? bars.map((bar) => (
          <div key={bar.week} className={`b p${bar.phaseIndex + 1}${bar.changed ? ' cut' : ''}${peak?.week === bar.week ? ' peak' : ''}`} style={{ height: `${bar.heightPct}%` }} title={bar.title} />
        )) : <div className="text-xs text-text-muted">暂无周量数据</div>}
      </div>
      <div className="pa-cband">
        {phases.map((phase, index) => (
          <div key={phase.id} className="seg" style={{ flex: Math.max(phase.weekCount, 1), background: PHASE_COLORS[index % PHASE_COLORS.length] }} />
        ))}
      </div>
      <div className="pa-caxis"><span>{phases[0]?.start ? `W01 · ${formatMonthDay(phases[0].start)}` : 'W01'}</span><span>{phases.at(-1)?.end ? `W${padWeek(totalWeeks || bars.length)} · ${formatMonthDay(phases.at(-1)?.end ?? '')}` : '终点暂无'}</span></div>
    </div>
  )
}

function PhaseDetailCard({ phase, index, isCurrent, changed }: { phase: DisplayPhase; index: number; isCurrent: boolean; changed: boolean }) {
  const color = PHASE_COLORS[index % PHASE_COLORS.length]
  const headerClass = `pa-pd-h ${isCurrent && !changed ? 'now' : ''} ${changed ? 'chg' : ''}`.trim()
  return (
    <div className={`pa-pd ${isCurrent && !changed ? 'now' : ''} ${changed ? 'chg' : ''}`.trim()}>
      <div className={headerClass}>
        <span className="sw" style={{ background: color }} />
        <span className="nm">{phaseName(index, phase.name)}</span>
        <span className="rg">{phaseRangeLabel(phase)}</span>
      </div>
      <div className="pa-pd-b">
        <div className="fc">{phaseFocusMarkup(phase)}</div>
        <div className="pa-pd-key">
          {phaseKeywords(phase).map((keyword) => <span key={keyword} className="k">{keyword}</span>)}
        </div>
      </div>
    </div>
  )
}

function ScanPanel({ scan, loading }: { scan: ScanState; loading: boolean }) {
  return (
    <section className="pa-panel">
      <div className="pa-phead">
        <div className="pa-badge scan"><SearchIcon /></div>
        <div>
          <div className="h">STRIDE 正在查看你的情况</div>
          <div className="s">运动数据 · 配速 / 心率区间 · 阈值 · 身体状态</div>
        </div>
        <div className={`pa-status ${loading ? '' : 'done'}`}>{loading ? <span className="pa-spin" /> : <CheckMiniIcon />}<span>{loading ? '分析中…' : '已完成'}</span></div>
      </div>
      <div className="pa-pbody pa-scan-body">
        <div className="pa-scan-grid">
          {scan.rows.slice(0, 6).map((row) => (
            <div key={row.id} data-testid={`scan-row-${row.id}`} className="pa-row lit">
              <span className="pa-check"><CheckMiniIcon /></span>
              <span className="label">{scanDesignLabel(row.label)}</span>
              <span className={`val ${row.tone === 'warn' ? 'warn' : ''}`}>{row.value}</span>
            </div>
          ))}
        </div>

        <div className="pa-zones">
          <ZoneTable
            title="配速区间"
            anchor="阈值配速"
            anchorValue={scan.paceZone || '暂无数据'}
            unit="区间 /km"
            rows={scan.paceRows}
          />
          <ZoneTable
            title="心率区间"
            anchor="阈值心率"
            anchorValue={scan.hrZone || '暂无数据'}
            unit="区间 bpm"
            rows={scan.hrRows}
          />
        </div>

        <div className="pa-summary">
          <div className="sh">
            <span className="sl">本阶段训练总结</span>
            <span className="sp">P1 基础期 · 当前周</span>
          </div>
          <div className="st">基础期正在搭建有氧底盘。近期完成度、跑量、RHR、HRV 和伤病信号会一起影响调整方向；如果出现 <b>疲劳或跟腱信号</b>，STRIDE 会优先保护身体，再处理关键课顺延。</div>
          <div className="pa-sstats">
            <div className="pa-sstat"><div className="sn">82%</div><div className="sd">阶段课次完成率</div></div>
            <div className="pa-sstat"><div className="sn">76%</div><div className="sd">Z2 有氧占比</div></div>
            <div className="pa-sstat"><div className="sn warn">{scan.rows[0]?.value ?? '暂无'}</div><div className="sd">本周完成度</div></div>
          </div>
        </div>

        <div className="pa-verdict">
          <div className="vl">STRIDE 初步判断</div>
          <div className="vt">近期扫描已经完成。下面我问你几个问题，确认清楚后再帮你把计划重排 ↓</div>
        </div>
      </div>
    </section>
  )
}

function GuidedFlow({
  answers,
  step,
  onAnswer,
  previewReady,
  adjustLoading,
  adjustError,
  diff,
  selectedOpIds,
  onToggleOp,
  onRetryAdjust,
  onRevise,
  onApply,
  applyLoading,
  applyError,
  affectedWeeks,
  hasPlanId,
}: {
  answers: FlowAnswers
  step: FlowStep
  onAnswer: (answer: string) => void
  previewReady: boolean
  adjustLoading: boolean
  adjustError: string | null
  diff: MasterPlanDiff | null
  selectedOpIds: Set<string>
  onToggleOp: (opId: string) => void
  onRetryAdjust: () => void
  onRevise: () => void
  onApply: () => void
  applyLoading: boolean
  applyError: string | null
  affectedWeeks: MasterPlanAffectedWeek[]
  hasPlanId: boolean
}) {
  const copy = FLOW_COPY[step]
  const acceptedCount = diff?.ops.filter((op) => selectedOpIds.has(op.id)).length ?? 0
  return (
    <section className="pa-convo">
      <div className="pa-msg">
        <div className="av">S</div>
        <div className="pa-bubble">我已经加载了当前计划和近期身体信号。请先告诉我这次主要想怎么调整。</div>
      </div>

      <div className="pa-aq">
        <div className="aq-q">{copy.question}</div>
        <div className="aq-hint">按你的回答生成左侧新计划预览，后端返回 diff 后可选择采纳。</div>

        {step !== 'preview' && (
          <div className="aq-opts">
          {copy.options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onAnswer(option)}
              className="aq-opt"
            >
              <span className="mk" />
              <span className="ol">{option}</span>
              <span className="od" aria-hidden="true">选择</span>
            </button>
          ))}
          </div>
        )}

      {previewReady && (
        <div className="space-y-3">
          <div className="rounded-xl border border-accent-green/25 bg-accent-green/5 p-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-accent-green-dim mb-1">新计划预览</div>
                <div className="text-sm font-semibold text-text-primary">方向：{buildAnswerSummary(answers)}</div>
                </div>
              <SparkIcon />
            </div>
          </div>

          {!hasPlanId && (
            <p className="text-xs text-text-muted">当前没有激活的 master plan，预览不会持久化。</p>
          )}

          {adjustLoading && <p className="text-xs text-text-muted">正在请求后端差异...</p>}
          {adjustError && (
            <div className="rounded-xl border border-accent-amber/30 bg-accent-amber/5 p-3">
              <div className="text-xs text-accent-amber">
                调整建议请求失败：{adjustError}。本地预览仍可继续查看。
              </div>
              {hasPlanId && (
                <button
                  type="button"
                  onClick={onRetryAdjust}
                  disabled={adjustLoading}
                  className="mt-2 inline-flex h-7 items-center rounded-md border border-accent-amber/30 bg-bg-card px-2.5 text-[11px] font-semibold text-accent-amber hover:bg-accent-amber/10 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  重试后端建议
                </button>
              )}
            </div>
          )}

          {diff && (
            <div className="rounded-xl border border-border-subtle bg-bg-primary p-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <h3 className="text-sm font-semibold text-text-primary">后端调整建议</h3>
                <span className="font-mono text-[11px] text-text-muted">{acceptedCount}/{diff.ops.length}</span>
              </div>
              {diff.ai_explanation && <p className="text-xs text-text-secondary mb-3">{diff.ai_explanation}</p>}
              <div className="space-y-2">
                {diff.ops.map((op) => (
                  <DiffOpRow
                    key={op.id}
                    op={op}
                    checked={selectedOpIds.has(op.id)}
                    onToggle={() => onToggleOp(op.id)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onApply}
              disabled={!diff?.diff_id || selectedOpIds.size === 0 || applyLoading}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-accent-green text-white text-xs font-semibold disabled:opacity-45 disabled:cursor-not-allowed hover:bg-accent-green-dim transition-colors"
            >
              <CheckIcon />
              {applyLoading ? '采用中...' : '采用这份计划'}
            </button>
            <button
              type="button"
              onClick={onRevise}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border-subtle bg-bg-primary text-xs font-semibold text-text-secondary hover:text-text-primary hover:border-border transition-colors"
            >
              <RefreshIcon />
              再调整一下
            </button>
          </div>

          {applyError && (
            <div className="rounded-xl border border-accent-red/30 bg-accent-red/5 p-3 text-xs text-accent-red">
              采用失败：{applyError}
            </div>
          )}

          {affectedWeeks.length > 0 && (
            <div className="rounded-xl border border-accent-green/25 bg-accent-green/5 p-3">
              <h3 className="text-sm font-semibold text-text-primary mb-2">受影响周次</h3>
              <div className="space-y-1">
                {affectedWeeks.map((week) => (
                  <div key={week.folder} className="font-mono text-xs text-accent-green-dim">{week.folder}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

        <div className="aq-foot">
          <span className="note">{hasPlanId ? '可生成持久化调整' : '当前仅生成本地预览'}</span>
        </div>
      </div>
    </section>
  )
}

function DiffOpRow({ op, checked, onToggle }: { op: MasterPlanDiffOp; checked: boolean; onToggle: () => void }) {
  return (
    <label className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-card p-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 accent-accent-green"
      />
      <span className="min-w-0">
        <span className="block text-xs font-semibold text-text-primary">{diffOpLabel(op.op)}</span>
        <span className="block text-[11px] text-text-muted mt-0.5 break-words">{summarizeDiffValue(op)}</span>
      </span>
    </label>
  )
}

function emptyScan(): ScanState {
  return {
    rows: [
      { id: 'completion', label: '完成度', value: '暂无数据', tone: 'neutral' },
      { id: 'mileage', label: '近期跑量', value: '暂无数据', tone: 'neutral' },
      { id: 'rhr', label: 'RHR', value: '暂无数据', tone: 'neutral' },
      { id: 'hrv', label: 'HRV / 睡眠', value: '暂无数据', tone: 'neutral' },
      { id: 'vo2max', label: '最新 VO₂max', value: '暂无数据', tone: 'neutral' },
      { id: 'injury', label: '伤病信号', value: '暂无数据', tone: 'neutral' },
      { id: 'load', label: '负荷状态', value: '暂无数据', tone: 'neutral' },
    ],
    paceZone: '',
    hrZone: '',
    paceRows: [],
    hrRows: [],
  }
}

function buildScanState({
  activities,
  health,
  hrv,
  pmc,
  zones,
  planDays,
  currentWeek,
}: {
  activities: Activity[] | null
  health: Awaited<ReturnType<typeof getHealth>> | null
  hrv: Awaited<ReturnType<typeof getHrv>> | null
  pmc: Awaited<ReturnType<typeof getPMC>> | null
  zones: StrideZonesResponse | null
  planDays: PlanDay[] | null
  currentWeek: { date_from: string; date_to: string } | null
}): ScanState {
  const rows = emptyScan().rows
  const update = (id: string, value: string, detail?: string, tone?: ScanRow['tone']) => {
    const row = rows.find((item) => item.id === id)
    if (row) Object.assign(row, { value, detail, tone: tone ?? 'ok' })
  }

  const currentWeekActivities = currentWeek && activities
    ? activities.filter((activity) => {
      const date = shanghaiDate(activity.date)
      return date >= currentWeek.date_from && date <= currentWeek.date_to
    })
    : null
  const plannedSessions = planDays
    ? planDays.flatMap((day) => day.sessions).filter((session) => session.kind !== 'rest' && session.kind !== 'note')
    : null
  if (plannedSessions && currentWeekActivities) {
    const done = Math.min(currentWeekActivities.length, plannedSessions.length)
    const pct = plannedSessions.length > 0 ? Math.round((done / plannedSessions.length) * 100) : 0
    update('completion', `${done}/${plannedSessions.length} 课 · ${pct}%`, undefined, pct >= 70 ? 'ok' : 'warn')
  }

  if (activities) {
    const mileage = activities.reduce((sum, activity) => sum + (activity.distance_km ?? 0), 0)
    update('mileage', `${mileage.toFixed(1)} km / 14天`)
    const vo2 = activities.find((activity) => activity.vo2max != null)?.vo2max
    if (vo2 != null) update('vo2max', String(vo2))
    const note = activities.map((activity) => activity.sport_note ?? '').find(hasInjurySignal)
    if (note) update('injury', truncate(note, 26), undefined, 'warn')
    else update('injury', '未发现明显信号')
  }

  const latestHealth = health?.health[0]
  if (latestHealth?.rhr != null) {
    const baseline = health?.rhr_baseline != null ? ` · 基线 ${health.rhr_baseline}` : ''
    update('rhr', `${latestHealth.rhr} bpm${baseline}`)
  }

  if (hrv?.summary.last_night_avg != null) {
    const sleep = latestHealth?.sleep_total_s ? ` · 睡眠 ${(latestHealth.sleep_total_s / 3600).toFixed(1)}h` : ''
    const score = latestHealth?.sleep_score != null ? ` / ${latestHealth.sleep_score}` : ''
    update('hrv', `${hrv.summary.last_night_avg} ms · ${hrv.summary.status ?? '未知'}${sleep}${score}`)
  }

  if (pmc?.stride_summary?.current_readiness_gate) {
    const form = pmc.stride_summary.current_form != null ? ` · Form ${pmc.stride_summary.current_form}` : ''
    update('load', `${pmc.stride_summary.current_readiness_gate}${form}`)
  }

  const pace = zones?.pace_zones.find((zone) => zone.name === 'Z2') ?? zones?.pace_zones[0]
  const hr = zones?.hr_zones.find((zone) => zone.name === 'Z2') ?? zones?.hr_zones[0]
  return {
    rows,
    paceZone: pace ? `${pace.name} ${pace.label} ${pace.lower_pace ?? '--'}-${pace.upper_pace ?? '--'}/km` : '',
    hrZone: hr ? `${hr.name} ${hr.label} HR ${hr.lower_bpm ?? '--'}-${hr.upper_bpm ?? '--'}` : '',
    paceRows: buildPaceZoneRows(zones),
    hrRows: buildHrZoneRows(zones),
  }
}

function toDisplayPhases(masterPlan: MasterPlan | null, fallbackPlan: TrainingPlan | null): DisplayPhase[] {
  if (masterPlan?.phases.length) {
    let cursor = 1
    const phases = masterPlan.phases.map((phase) => {
      const weekCount = weeksBetween(phase.start_date, phase.end_date) || 1
      const displayPhase = {
        id: phase.id,
        name: phase.name,
        start: phase.start_date,
        end: phase.end_date,
        focus: phase.focus,
        low: phase.weekly_distance_km_low,
        high: phase.weekly_distance_km_high,
        weekStart: cursor,
        weekEnd: cursor + weekCount - 1,
        weekCount,
        keySessions: phase.key_session_types ?? [],
      }
      cursor = displayPhase.weekEnd + 1
      return displayPhase
    })
    const totalWeeks = masterPlan.total_weeks
    if (totalWeeks && phases.length > 0 && phases[phases.length - 1].weekEnd !== totalWeeks) {
      const last = phases[phases.length - 1]
      last.weekEnd = totalWeeks
      last.weekCount = Math.max(1, last.weekEnd - last.weekStart + 1)
    }
    return phases
  }
  let cursor = 1
  return (fallbackPlan?.phases ?? []).map((phase, index) => {
    const weekCount = weeksBetween(phase.start, phase.end) || 1
    const displayPhase = {
      id: `${index}-${phase.name}`,
      name: phase.name,
      start: phase.start,
      end: phase.end,
      focus: phase.name,
      low: null,
      high: null,
      weekStart: cursor,
      weekEnd: cursor + weekCount - 1,
      weekCount,
      keySessions: [],
    }
    cursor = displayPhase.weekEnd + 1
    return displayPhase
  })
}

function buildPreviewPhases(phases: DisplayPhase[], answers: FlowAnswers): DisplayPhase[] {
  const deload = answers.intent?.includes('减量') || answers.intent?.includes('顺延')
  return phases.map((phase, index) => {
    if (index > 1) return phase
    if (deload) {
      return {
        ...phase,
        focus: index === 0 ? '恢复优先，保留轻松跑与基础力量' : phase.focus,
        low: phase.low != null ? Math.max(0, Math.round(phase.low * 0.82)) : phase.low,
        high: phase.high != null ? Math.max(0, Math.round(phase.high * 0.85)) : phase.high,
        changed: true,
      }
    }
    return {
      ...phase,
      focus: index === 0 ? `${answers.focus ?? '专项能力'}，控制递增` : phase.focus,
      high: phase.high != null ? Math.round(phase.high + 6) : phase.high,
      changed: index === 0,
    }
  })
}

function composeAdjustMessage(answers: FlowAnswers, scan: ScanState): string {
  const rows = scan.rows.map((row) => `${row.label}: ${row.value}`).join('；')
  return `请按以下信息调整当前 master plan：意图=${answers.intent ?? '未选择'}；身体重点=${answers.body ?? '无'}；能力重点=${answers.focus ?? '无'}；可用训练=${answers.sessions ?? '未选择'}。近期扫描：${rows}。`
}

function composeChangeReason(answers: FlowAnswers): string {
  return [answers.intent, answers.body ?? answers.focus, answers.sessions].filter(Boolean).join(' · ')
}

function buildAnswerSummary(answers: FlowAnswers): string {
  const middle = answers.body ?? answers.focus
  return [middle, answers.sessions].filter(Boolean).join(' · ') || '等待选择'
}

function planReferenceTitle(masterPlan: MasterPlan | null, phases: DisplayPhase[], target: TargetProfile): string {
  const raceName = target.raceName || '目标赛事'
  const totalWeeks = planTotalWeeks(masterPlan, phases)
  return `从现在到${raceName} · ${totalWeeks || '--'} 周`
}

function planMeta(masterPlan: MasterPlan | null, fallbackPlan: TrainingPlan | null, isNew: boolean): string {
  if (isNew) return 'STRIDE 重新规划 · 基于本次反馈 · 未保存'
  if (masterPlan) return `训练总纲 · v${masterPlan.version} · ${masterPlan.updated_at.slice(0, 10)}`
  if (fallbackPlan?.current_phase) return `旧版 plan.md · ${fallbackPlan.current_phase}`
  return '训练总纲 · 当前版本'
}

function planTotalWeeks(masterPlan: MasterPlan | null, phases: DisplayPhase[]): number {
  return masterPlan?.total_weeks ?? phases.at(-1)?.weekEnd ?? phases.reduce((total, phase) => total + phase.weekCount, 0)
}

function buildMileageBars(phases: DisplayPhase[], totalWeeks: number): PlanMileageBar[] {
  const raw = phases.flatMap((phase, phaseIndex) => Array.from({ length: phase.weekCount }, (_, localIndex) => {
    const week = phase.weekStart + localIndex
    const km = interpolateWeeklyKm(phase, localIndex)
    return { week, km, phaseIndex, changed: Boolean(phase.changed) }
  })).filter(bar => !totalWeeks || bar.week <= totalWeeks)
  const maxKm = Math.max(...raw.map(bar => bar.km ?? 0), 1)
  return raw.map(bar => ({
    ...bar,
    heightPct: bar.km == null ? 42 : Math.max(8, Math.round((bar.km / maxKm) * 100)),
    title: bar.km == null ? `W${padWeek(bar.week)} 暂无周量数据` : `W${padWeek(bar.week)} ${bar.km}km`,
  }))
}

function interpolateWeeklyKm(phase: DisplayPhase, localIndex: number): number | null {
  if (phase.low == null || phase.high == null) return null
  if (phase.weekCount <= 1) return Math.round(phase.high)
  const ratio = localIndex / (phase.weekCount - 1)
  return Math.round(phase.low + ((phase.high - phase.low) * ratio))
}

function findPeakBar(bars: PlanMileageBar[]): PlanMileageBar | null {
  return bars.reduce<PlanMileageBar | null>((peak, bar) => {
    if (bar.km == null) return peak
    if (!peak || peak.km == null || bar.km > peak.km) return bar
    return peak
  }, null)
}

function phaseName(index: number, name: string): string {
  if (name.includes('Phase 1') || name.includes('基础')) return 'P1 基础期'
  if (name.includes('Phase 2') || name.includes('专项')) return 'P2 专项期'
  if (name.includes('Phase 3') || name.includes('马拉松')) return 'P3 马拉松期'
  if (name.includes('Phase 4') || name.includes('减量')) return 'P4 减量期'
  if (name.includes('比赛') || name.includes('恢复')) return '比赛 + 恢复'
  return `P${index + 1} ${name}`
}

function phaseRangeLabel(phase: DisplayPhase): string {
  const weeks = `W${padWeek(phase.weekStart)}-W${padWeek(phase.weekEnd)} · ${phase.weekCount} 周`
  const range = `${formatMonthDay(phase.start)}-${formatMonthDay(phase.end)}`
  const volume = formatRange(phase.low, phase.high)
  return `${weeks} · ${range} · ${volume}`
}

function phaseFocusMarkup(phase: DisplayPhase) {
  const focus = phase.focus || '暂无阶段重点'
  return <><b>{focus}</b>，按当前能力和恢复状态控制周量递进。</>
}

function phaseKeywords(phase: DisplayPhase): string[] {
  if (phase.keySessions.length > 0) return phase.keySessions
  if (phase.focus.includes('恢复')) return ['恢复慢跑 Z2', '关键课顺延', '力量维持']
  return ['暂无关键课型']
}

function formatMonthDay(ymd: string): string {
  const [, month, day] = ymd.split('-')
  if (!month || !day) return ymd
  return `${month}/${day}`
}

function readTargetProfile(profile: MyProfile | null): TargetProfile {
  const raw = profile?.profile || {}
  const distance = stringField(raw, 'target_distance')
  return {
    raceName: stringField(raw, 'target_race'),
    distance: distanceLabel(distance),
    raceDate: stringField(raw, 'target_race_date'),
    targetTime: stringField(raw, 'target_time'),
  }
}

function stringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value.trim() : ''
}

function distanceLabel(value: string): string {
  const labels: Record<string, string> = { '5K': '5K', '10K': '10K', HM: '半马', FM: '全马' }
  return labels[value] || value
}

function formatSlashDate(ymd: string): string {
  const [year, month, day] = ymd.split('T')[0].split('-')
  if (!year || !month || !day) return ymd
  return `${year} / ${month} / ${day}`
}

function daysUntil(ymd: string): number | null {
  const race = parseDateOnly(ymd)
  const today = parseDateOnly(shanghaiToday())
  if (!race || !today) return null
  return Math.max(0, Math.ceil((race.getTime() - today.getTime()) / 86400000))
}

function weeksUntil(ymd: string): number | null {
  const days = daysUntil(ymd)
  return days == null ? null : Math.ceil(days / 7)
}

function weeksBetween(start: string, end: string): number {
  const startDate = parseDateOnly(start)
  const endDate = parseDateOnly(end)
  if (!startDate || !endDate || endDate < startDate) return 0
  const days = Math.floor((endDate.getTime() - startDate.getTime()) / 86400000) + 1
  return Math.max(1, Math.ceil(days / 7))
}

function parseDateOnly(value: string): Date | null {
  const [year, month, day] = value.split('T')[0].split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function padWeek(week: number): string {
  return String(week).padStart(2, '0')
}

function scanDesignLabel(label: string): string {
  const labels: Record<string, string> = {
    完成度: '本周完成度',
    近期跑量: '近 2 周训练量',
    RHR: '静息心率 (RHR)',
    'HRV / 睡眠': 'HRV / 睡眠质量',
    '最新 VO₂max': 'VO₂max 估算',
    伤病信号: '伤病 / 不适信号',
    负荷状态: '负荷状态',
  }
  return labels[label] ?? label
}

interface ZoneRow {
  zone: string
  label: string
  range: string
  color: string
  threshold?: boolean
}

function ZoneTable({ title, anchor, anchorValue, unit, rows }: { title: string; anchor: string; anchorValue: string; unit: string; rows: ZoneRow[] }) {
  const displayRows = rows.length > 0 ? rows : [{ zone: '--', label: '暂无数据', range: '--', color: '#8a8f98' }]
  return (
    <div className="pa-zcard">
      <div className="zhead">
        <div>
          <div className="ztitle">{title}</div>
          <div className="zsub">STRIDE-derived</div>
        </div>
        <div className="zanchor">{anchor} <b>{anchorValue}</b></div>
      </div>
      <table className="pa-ztable">
        <thead><tr><th>Zone</th><th>名称</th><th>{unit}</th></tr></thead>
        <tbody>
          {displayRows.map((row) => (
            <tr key={row.zone} className={row.threshold ? 'thr' : ''}>
              <td className="zn" style={{ color: row.color }}><span className="dot" style={{ background: row.color }} />{row.zone}</td>
              <td className="zl">{row.label}</td>
              <td className="zr">{row.range}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function buildPaceZoneRows(zones: StrideZonesResponse | null): ZoneRow[] {
  return (zones?.pace_zones ?? []).map((zone, index) => ({
    zone: zone.name,
    label: zone.label,
    range: `${zone.lower_pace ?? '--'}-${zone.upper_pace ?? '--'}`,
    color: zoneColor(index),
    threshold: zone.name === 'Z4',
  }))
}

function buildHrZoneRows(zones: StrideZonesResponse | null): ZoneRow[] {
  return (zones?.hr_zones ?? []).map((zone, index) => ({
    zone: zone.name,
    label: zone.label,
    range: `${zone.lower_bpm ?? '--'}-${zone.upper_bpm ?? '--'}`,
    color: zoneColor(index),
    threshold: zone.name === 'Z4',
  }))
}

function zoneColor(index: number): string {
  return ['#00a85a', '#64b800', '#e68a00', '#ff6d00', '#d32f2f', '#c2185b'][index] ?? '#8a8f98'
}

function findCurrentWeek(weeks: Array<{ date_from: string; date_to: string }>, today: string) {
  return weeks.find((week) => week.date_from <= today && week.date_to >= today) ?? weeks[0] ?? null
}

function addDays(ymd: string, delta: number): string {
  const [year, month, day] = ymd.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + delta)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function formatRange(low: number | null, high: number | null): string {
  if (low == null && high == null) return '周量 --'
  return `${low ?? '--'}-${high ?? '--'} km/w`
}

function hasInjurySignal(value: string): boolean {
  return /痛|疼|伤|紧|僵|跟腱|膝|小腿|髂/.test(value)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function diffOpLabel(op: string): string {
  const labels: Record<string, string> = {
    add_phase: '新增阶段',
    remove_phase: '删除阶段',
    resize_phase: '调整阶段日期',
    replace_phase_focus: '调整阶段重点',
    replace_weekly_range: '调整周量区间',
    add_milestone: '新增里程碑',
    remove_milestone: '删除里程碑',
    replace_milestone_date: '调整里程碑日期',
    replace_milestone_target: '调整里程碑目标',
  }
  return labels[op] ?? op
}

function summarizeDiffValue(op: MasterPlanDiffOp): string {
  const oldValue = op.old_value ? JSON.stringify(op.old_value) : '无'
  const newValue = op.new_value ? JSON.stringify(op.new_value) : '无'
  return `${oldValue} -> ${newValue}`
}

function BackIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function CheckMiniIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function PulseMiniIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <path d="M3 12h7l2-5 3 10 2-5h4" />
    </svg>
  )
}

function ArrowMiniIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

function PlusCircleMiniIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
      <path d="M12 8v8M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  )
}

function SparkIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="text-accent-green" aria-hidden="true">
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M21 12a9 9 0 11-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  )
}
