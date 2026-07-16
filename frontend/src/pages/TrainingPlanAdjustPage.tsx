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
import { findCurrentWeek } from '../lib/weeklyPlanView'
import { useUser } from '../UserContextValue'

type FlowStep = 'direction' | 'phase' | 'clarification' | 'assessment' | 'proposal'
type PreviewMode = 'current' | 'new'

interface FlowAnswers {
  direction?: string
  phase?: string
}

type AdjustmentAssessment = NonNullable<
  Awaited<ReturnType<typeof sendMasterPlanAdjustMessage>>['data']['assessment']
>

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

const DIRECTION_SUGGESTIONS = [
  '把周跑量降低到 45–50 公里',
  '把周跑量提高到 55–65 公里',
  '把训练重点改成马拉松配速耐力',
  '把这个阶段延长两周',
]

const PHASE_OPTIONS = ['当前阶段', '基础期', '专项期', '调整期', '下一阶段']
const PHASE_TARGET_REQUIRED_RE = /训练重点|重点(?:改|调|放)|侧重|聚焦|专注|周跑量|周量区间|训练量|减量|加量|延长|缩短/i
const EXPLICIT_PHASE_TARGET_RE = /基础期|基础阶段|专项期|专项阶段|强化期|高峰期|赛前期|减量期|调整期|恢复期|恢复阶段|当前阶段|现阶段|这个阶段|本阶段|下一阶段|下个阶段|后续阶段|第\s*[一二三四五六七八九十0-9]+\s*(?:个)?阶段|phase[-_ ]?[a-z0-9]+/i
const VOLUME_CHANGE_RE = /加量|减量|增加|加大|提高|提升|降低|减少/i
const EXPLICIT_VOLUME_TARGET_RE = /\d+(?:\.\d+)?\s*(?:公里|km)?\s*[–—\-~至到]\s*\d+(?:\.\d+)?\s*(?:公里|km)|\d+(?:\.\d+)?\s*%/i

const PHASE_COLORS = ['#00a85a', '#0097a7', '#e68a00', '#7c4dff', '#d32f2f']

export default function TrainingPlanAdjustPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const [masterPlan, setMasterPlan] = useState<MasterPlan | null>(null)
  const [fallbackPlan, setFallbackPlan] = useState<TrainingPlan | null>(null)
  const [profile, setProfile] = useState<MyProfile | null>(null)
  const [loadingPlan, setLoadingPlan] = useState(true)
  const [scanLoading, setScanLoading] = useState(false)
  const [scan, setScan] = useState<ScanState>(() => emptyScan())
  const [answers, setAnswers] = useState<FlowAnswers>({})
  const [step, setStep] = useState<FlowStep>('direction')
  const [directionDraft, setDirectionDraft] = useState('')
  const [clarificationDraft, setClarificationDraft] = useState('')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('current')
  const [diff, setDiff] = useState<MasterPlanDiff | null>(null)
  const [selectedOpIds, setSelectedOpIds] = useState<Set<string>>(new Set())
  const [adjustLoading, setAdjustLoading] = useState(false)
  const [adjustError, setAdjustError] = useState<string | null>(null)
  const [coachReply, setCoachReply] = useState<string | null>(null)
  const [assessment, setAssessment] = useState<AdjustmentAssessment | null>(null)
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

  const currentPhases = useMemo(() => toDisplayPhases(masterPlan, fallbackPlan), [masterPlan, fallbackPlan])
  const previewPhases = useMemo(() => applyDiffToDisplayPhases(currentPhases, diff), [currentPhases, diff])
  const targetProfile = useMemo(() => readTargetProfile(profile), [profile])
  const previewReady = step === 'proposal'

  const confirmDirection = () => {
    const direction = directionDraft.trim()
    if (!direction) return
    const nextAnswers = { direction }
    setAnswers(nextAnswers)
    if (adjustmentNeedsPhase(direction)) {
      setStep('phase')
      return
    }
    void requestAdjustDiff(nextAnswers)
  }

  const confirmPhase = (phase: string) => {
    const nextAnswers = { ...answers, phase }
    setAnswers(nextAnswers)
    void requestAdjustDiff(nextAnswers)
  }

  const confirmClarification = () => {
    const detail = clarificationDraft.trim()
    if (!detail) return
    const direction = [answers.direction, detail].filter(Boolean).join('；')
    const nextAnswers = { ...answers, direction }
    setAnswers(nextAnswers)
    setClarificationDraft('')
    void requestAdjustDiff(nextAnswers)
  }

  const restartFlow = () => {
    setAnswers({})
    setDirectionDraft('')
    setClarificationDraft('')
    setStep('direction')
    setPreviewMode('current')
    setDiff(null)
    setSelectedOpIds(new Set())
    setAdjustError(null)
    setCoachReply(null)
    setAssessment(null)
    setApplyError(null)
    setAffectedWeeks([])
  }

  const requestAdjustDiff = async (nextAnswers: FlowAnswers) => {
    setAdjustError(null)
    setDiff(null)
    setSelectedOpIds(new Set())
    setCoachReply(null)
    setAssessment(null)
    if (!masterPlan?.plan_id) return
    setAdjustLoading(true)
    try {
      const response = await sendMasterPlanAdjustMessage(
        masterPlan.plan_id,
        composeAdjustMessage(nextAnswers),
        [],
      )
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setCoachReply(response.data.ai_response)
      setAssessment(response.data.assessment ?? null)
      const nextDiff = response.data.diff
      setDiff(nextDiff)
      setSelectedOpIds(new Set(nextDiff?.ops.map((op) => op.id) ?? []))
      if (response.data.stage === 'proposal' && nextDiff) {
        void loadScan()
        setStep('proposal')
        setPreviewMode('new')
      } else if (response.data.stage === 'clarification') {
        setStep('clarification')
      } else {
        void loadScan()
        setStep('assessment')
      }
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
        <p className="text-[13px] text-text-secondary mt-1.5 max-w-[620px]">先说清楚想调整的方向，必要时再确认阶段。澄清后 STRIDE 才会加载训练数据、判断想法是否合理；只有合理时才生成可应用方案。</p>
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
          diff={diff}
          summary={diff?.ai_explanation ?? ''}
        />

        <div className="pa-flow">
          {(step === 'assessment' || step === 'proposal') && <ScanPanel scan={scan} loading={scanLoading} />}
          <GuidedFlow
            answers={answers}
            step={step}
            directionDraft={directionDraft}
            onDirectionDraft={setDirectionDraft}
            clarificationDraft={clarificationDraft}
            onClarificationDraft={setClarificationDraft}
            onConfirmClarification={confirmClarification}
            onConfirmDirection={confirmDirection}
            onPhase={confirmPhase}
            previewReady={previewReady}
            adjustLoading={adjustLoading}
            scanLoading={scanLoading}
            adjustError={adjustError}
            coachReply={coachReply}
            assessment={assessment}
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
  diff,
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
  diff: MasterPlanDiff | null
  summary: string
}) {
  const isNew = previewReady && mode === 'new'
  const previewTarget = useMemo(
    () => applyDiffToTargetProfile(targetProfile, masterPlan, diff),
    [targetProfile, masterPlan, diff],
  )
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
          targetProfile={previewTarget}
          targetChanged={targetProfileChanged(targetProfile, previewTarget)}
          summary={summary}
        />
      ) : (
        <PlanReferenceView
          kind="current"
          phases={currentPhases}
          masterPlan={masterPlan}
          fallbackPlan={fallbackPlan}
          targetProfile={targetProfile}
          targetChanged={false}
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
  targetChanged,
  summary,
}: {
  kind: 'current' | 'new'
  phases: DisplayPhase[]
  masterPlan: MasterPlan | null
  fallbackPlan: TrainingPlan | null
  targetProfile: TargetProfile
  targetChanged: boolean
  summary: string
}) {
  const isNew = kind === 'new'
  const totalWeeks = isNew
    ? phases.at(-1)?.weekEnd ?? planTotalWeeks(masterPlan, phases)
    : planTotalWeeks(masterPlan, phases)
  return (
    <div className="pa-planview">
      <div className="pa-chead">
        <div className={`pa-ctag ${isNew ? 'newt' : ''}`}>{isNew ? '新计划 · 已生成' : '当前计划'}</div>
        <div className="pa-ctitle">{planReferenceTitle(targetProfile, totalWeeks)}{isNew ? '（已调整）' : ''}</div>
        <div className="pa-cmeta">{planMeta(masterPlan, fallbackPlan, isNew)}</div>
      </div>
      <div className="pa-cbody">
        {isNew && <PlanChanges summary={summary} />}
        <RaceCard
          changed={Boolean(isNew && targetChanged)}
          target={targetProfile}
          masterPlan={masterPlan}
        />
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
      <div className="ch-l">Coach typed proposal</div>
      <div className="pa-chrow">
        <PulseMiniIcon className="ic" />
        <div className="tx"><b>{summary || '调整方案已通过合理性门槛'}</b><span className="why"> — 仅展示后端返回的结构化 diff</span></div>
      </div>
    </div>
  )
}

function RaceCard({ changed, target, masterPlan }: { changed: boolean; target: TargetProfile; masterPlan: MasterPlan | null }) {
  const raceName = target.raceName || '目标比赛暂无数据'
  const raceDate = target.raceDate || masterPlan?.end_date || ''
  const weeks = raceDate ? weeksUntil(raceDate) : null
  const days = raceDate ? daysUntil(raceDate) : null
  const distance = target.distance || '距离暂无数据'
  const targetTime = target.targetTime ? ` · 目标 ${target.targetTime}` : ''
  return (
    <div className="pa-race">
      <div className="top">
        <div className="rl">目标比赛{changed ? ' · 已调整' : ''}</div>
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
          <div className="st">近期完成度、跑量、RHR、HRV 和伤病信号会与当前计划、PMC 及负荷估算一起进入合理性判断。</div>
          <div className="pa-sstats">
            {scan.rows.slice(0, 3).map((row) => (
              <div key={row.id} className="pa-sstat"><div className={`sn ${row.tone === 'warn' ? 'warn' : ''}`}>{row.value}</div><div className="sd">{scanDesignLabel(row.label)}</div></div>
            ))}
          </div>
        </div>

        <div className="pa-verdict">
          <div className="vl">评估数据已加载</div>
          <div className="vt">Coach 会先判断你的具体想法是否合理；只有 verdict=reasonable 才会生成调整方案。</div>
        </div>
      </div>
    </section>
  )
}

function GuidedFlow({
  answers,
  step,
  directionDraft,
  onDirectionDraft,
  clarificationDraft,
  onClarificationDraft,
  onConfirmClarification,
  onConfirmDirection,
  onPhase,
  previewReady,
  adjustLoading,
  scanLoading,
  adjustError,
  coachReply,
  assessment,
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
  directionDraft: string
  onDirectionDraft: (value: string) => void
  clarificationDraft: string
  onClarificationDraft: (value: string) => void
  onConfirmClarification: () => void
  onConfirmDirection: () => void
  onPhase: (phase: string) => void
  previewReady: boolean
  adjustLoading: boolean
  scanLoading: boolean
  adjustError: string | null
  coachReply: string | null
  assessment: AdjustmentAssessment | null
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
  const acceptedCount = diff?.ops.filter((op) => selectedOpIds.has(op.id)).length ?? 0
  const stageIndex = step === 'direction' ? 0 : step === 'phase' || step === 'clarification' ? 1 : step === 'assessment' ? 2 : 3
  return (
    <section className="pa-convo">
      <ol className="grid grid-cols-4 gap-2" aria-label="调整流程">
        {['调整方向', '目标阶段（按需）', '数据评估', '调整方案'].map((label, index) => (
          <li
            key={label}
            className={`rounded-lg border px-2 py-2 text-center font-mono text-[10px] ${
              index < stageIndex
                ? 'border-accent-green/30 bg-accent-green/5 text-accent-green-dim'
                : index === stageIndex
                  ? 'border-accent-green bg-accent-green/10 text-accent-green-dim'
                  : 'border-border-subtle bg-bg-card text-text-muted opacity-60'
            }`}
          >
            {padWeek(index + 1)} {label}
          </li>
        ))}
      </ol>
      <div className="pa-msg">
        <div className="av">S</div>
        <div className="pa-bubble">
          {step === 'direction' && '先告诉我你想怎么调整。此时不会读取训练数据，也不会生成方案。'}
          {step === 'phase' && '方向已经明确。还需要确认要调整哪个阶段，之后我才会加载数据评估。'}
          {step === 'clarification' && (coachReply || '还需要补充一个细节，确认后我才会加载数据评估。')}
          {step === 'assessment' && (coachReply || '正在读取当前计划、身体状态与 STRIDE 训练负荷，判断这个想法是否合理。')}
          {step === 'proposal' && (coachReply || '这个想法有数据支持，下面是可应用的调整方案。')}
        </div>
      </div>

      <div className="pa-aq">
        {step === 'direction' && (
          <>
            <label htmlFor="adjust-direction" className="aq-q block">这次具体想怎么调整训练计划？</label>
            <div className="aq-hint">请给出明确方向，例如周量、训练重点、阶段长度或比赛目标怎么变。</div>
            <textarea
              id="adjust-direction"
              value={directionDraft}
              onChange={(event) => onDirectionDraft(event.target.value)}
              rows={3}
              placeholder="例如：把专项期周跑量降低到 45–50 公里"
              className="mt-3 w-full resize-y rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent-green"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              {DIRECTION_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onDirectionDraft(suggestion)}
                  className="rounded-full border border-border-subtle bg-bg-card px-2.5 py-1.5 text-[11px] text-text-secondary hover:border-accent-green/40"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onConfirmDirection}
              disabled={!directionDraft.trim()}
              className="mt-4 inline-flex h-9 items-center rounded-lg bg-accent-green px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认调整方向
            </button>
          </>
        )}

        {step === 'phase' && (
          <>
            <div className="aq-q">你希望调整哪个阶段？</div>
            <div className="aq-hint">方向：{answers.direction}</div>
            <div className="aq-opts">
              {PHASE_OPTIONS.map((phase) => (
                <button key={phase} type="button" onClick={() => onPhase(phase)} className="aq-opt">
                  <span className="mk" />
                  <span className="ol">{phase}</span>
                  <span className="od" aria-hidden="true">选择</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'clarification' && (
          <>
            <label htmlFor="adjust-clarification" className="aq-q block">请补充调整细节</label>
            <div className="aq-hint">{coachReply}</div>
            <textarea
              id="adjust-clarification"
              value={clarificationDraft}
              onChange={(event) => onClarificationDraft(event.target.value)}
              rows={2}
              placeholder="例如：专项期增加到 82–96 公里"
              className="mt-3 w-full resize-y rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent-green"
            />
            <button
              type="button"
              onClick={onConfirmClarification}
              disabled={!clarificationDraft.trim()}
              className="mt-4 inline-flex h-9 items-center rounded-lg bg-accent-green px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              确认补充信息
            </button>
          </>
        )}

        {step === 'assessment' && (
          <div className="space-y-3">
            <div className="aq-q">数据评估</div>
            <div className="aq-hint">{buildAnswerSummary(answers)}</div>
            {(adjustLoading || scanLoading) && (
              <div className="rounded-xl border border-accent-cyan/25 bg-accent-cyan/5 p-3 text-xs text-text-secondary">
                正在读取当前计划、健康状态、PMC 与计划负荷估算…
              </div>
            )}
            {assessment && (
              <div className={`rounded-xl border p-3 ${
                assessment.verdict === 'reasonable'
                  ? 'border-accent-green/25 bg-accent-green/5'
                  : 'border-accent-amber/30 bg-accent-amber/5'
              }`}>
                <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                  {assessment.verdict === 'reasonable' ? '想法合理' : assessment.verdict === 'unreasonable' ? '暂不建议' : '需要继续澄清'}
                </div>
                <p className="mt-1.5 text-sm leading-6 text-text-primary">{assessment.rationale}</p>
              </div>
            )}
            {assessment && assessment.verdict !== 'reasonable' && (
              <button type="button" onClick={onRevise} className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-semibold text-text-secondary">
                修改我的想法
              </button>
            )}
            {!adjustLoading && coachReply && !assessment && (
              <button type="button" onClick={onRevise} className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-semibold text-text-secondary">
                修改我的想法
              </button>
            )}
          </div>
        )}

        {adjustError && (
          <div className="rounded-xl border border-accent-amber/30 bg-accent-amber/5 p-3">
            <div className="text-xs text-accent-amber">评估请求失败：{adjustError}</div>
            {hasPlanId && (
              <button type="button" onClick={onRetryAdjust} disabled={adjustLoading} className="mt-2 text-xs font-semibold text-accent-amber disabled:opacity-50">
                重试评估
              </button>
            )}
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
              修改我的想法
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
          <span className="note">{stageIndex < 2 ? '澄清完成前不读取训练数据、不生成方案' : hasPlanId ? '合理性通过后才可应用调整' : '当前没有可调整的激活计划'}</span>
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

function applyDiffToDisplayPhases(phases: DisplayPhase[], diff: MasterPlanDiff | null): DisplayPhase[] {
  if (!diff) return phases
  let cursor = 1
  return phases.map((phase) => {
    const directPatches = diff.ops
      .filter((op) => op.phase_id === phase.id)
      .map((op) => ({ ...(op.new_value ?? {}), ...(op.spec_patch ?? {}) }))
    const atomicPatches = diff.ops.flatMap((op) => {
      const phaseUpdates = op.spec_patch?.phase_updates
      if (!Array.isArray(phaseUpdates)) return []
      return phaseUpdates.filter(
        (update): update is Record<string, unknown> => isRecord(update) && update.phase_id === phase.id,
      )
    })
    const patches = [...directPatches, ...atomicPatches]
    const next = patches.reduce<DisplayPhase>((current, patch) => ({
      ...current,
      start: stringValue(patch.start_date) || current.start,
      end: stringValue(patch.end_date) || current.end,
      focus: stringValue(patch.focus) || current.focus,
      low: typeof patch.weekly_distance_km_low === 'number'
        ? patch.weekly_distance_km_low
        : current.low,
      high: typeof patch.weekly_distance_km_high === 'number'
        ? patch.weekly_distance_km_high
        : current.high,
      changed: true,
    }), phase)
    const weekCount = weeksBetween(next.start, next.end) || next.weekCount
    const timelinePhase = {
      ...next,
      weekStart: cursor,
      weekEnd: cursor + weekCount - 1,
      weekCount,
    }
    cursor = timelinePhase.weekEnd + 1
    return timelinePhase
  })
}

function applyDiffToTargetProfile(
  target: TargetProfile,
  masterPlan: MasterPlan | null,
  diff: MasterPlanDiff | null,
): TargetProfile {
  if (!diff) return target
  return diff.ops.reduce<TargetProfile>((next, op) => {
    const patch = op.spec_patch ?? {}
    if (op.op === 'reschedule_target_race') {
      const raceDate = stringValue(patch.race_date) || stringValue(patch.milestone_date)
      return raceDate ? { ...next, raceDate } : next
    }
    if (op.op === 'update_target_race_time') {
      const targetTime = stringValue(patch.target_time)
      return targetTime ? { ...next, targetTime } : next
    }
    if (op.op === 'replace_milestone_date' && op.milestone_id === targetRaceMilestoneId(masterPlan)) {
      const raceDate = stringValue(patch.date) || stringValue(op.new_value?.date)
      return raceDate ? { ...next, raceDate } : next
    }
    if (op.op === 'replace_milestone_target' && op.milestone_id === targetRaceMilestoneId(masterPlan)) {
      const milestoneTarget = stringValue(patch.target) || stringValue(op.new_value?.target)
      return milestoneTarget ? { ...next, targetTime: extractTargetTime(milestoneTarget) || next.targetTime } : next
    }
    return next
  }, target)
}

function targetProfileChanged(current: TargetProfile, next: TargetProfile): boolean {
  return current.raceName !== next.raceName
    || current.distance !== next.distance
    || current.raceDate !== next.raceDate
    || current.targetTime !== next.targetTime
}

function targetRaceMilestoneId(masterPlan: MasterPlan | null): string | null {
  return masterPlan?.milestones.find((milestone) => milestone.type === 'race')?.id ?? null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractTargetTime(value: string): string {
  return value.match(/\b(?:[0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}\b/)?.[0] ?? ''
}

function composeAdjustMessage(answers: FlowAnswers): string {
  if (answers.phase) return `${answers.phase}：${answers.direction ?? '未说明方向'}`
  return answers.direction ?? '未说明方向'
}

function adjustmentNeedsPhase(direction: string): boolean {
  if (VOLUME_CHANGE_RE.test(direction)) {
    if (!EXPLICIT_VOLUME_TARGET_RE.test(direction)) return false
    return !EXPLICIT_PHASE_TARGET_RE.test(direction)
  }
  return PHASE_TARGET_REQUIRED_RE.test(direction) && !EXPLICIT_PHASE_TARGET_RE.test(direction)
}

function composeChangeReason(answers: FlowAnswers): string {
  return [answers.phase, answers.direction].filter(Boolean).join(' · ')
}

function buildAnswerSummary(answers: FlowAnswers): string {
  return [answers.phase, answers.direction].filter(Boolean).join(' · ') || '等待澄清'
}

function planReferenceTitle(target: TargetProfile, totalWeeks: number): string {
  const raceName = target.raceName || '目标赛事'
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
