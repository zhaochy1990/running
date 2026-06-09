import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getCurrentMasterPlan,
  getTrainingPlan,
  getMyProfile,
  type MasterPlan,
  type MasterPlanMilestone,
  type MyProfile,
  type TrainingPlan,
} from '../api'
import { useUser } from '../UserContextValue'
import TrainingPlanSetup from './TrainingPlanSetup'
import ViewHead from '../components/ViewHead'
import WeeksGrid from '../components/WeeksGrid'

type PlanTab = 'overview' | 'weeks'
type PageState = 'loading' | 'setup' | 'plan'

type TargetProfile = {
  raceName: string
  distance: string
  raceDate: string
  targetTime: string
}

type DisplayPhase = {
  id: string
  name: string
  startDate: string
  endDate: string
  focus: string
  weekStart: number
  weekEnd: number
  weekCount: number
  weeklyLow: number | null
  weeklyHigh: number | null
  keySessions: string[]
  milestoneIds: string[]
  color: string
}

type MileageBar = {
  week: number
  km: number | null
  className: string
  title: string
  heightPct: number
}

type SideRow = {
  marker: string
  label: string
  sub: string
  value: string
}

type PlanDisplayModel = {
  key: string
  source: 'master' | 'training-plan' | 'empty'
  eyebrow: string
  title: string
  lede: string
  totalWeeks: number
  currentWeek: number | null
  currentPhaseId: string | null
  phases: DisplayPhase[]
  milestones: MasterPlanMilestone[]
  trainingPrinciples: string[]
  bars: MileageBar[]
  chartTitle: string
  chartMeta: string
  axisLabels: string[]
  fallbackSummary: string
}

const PHASE_COLORS = ['var(--green)', 'var(--cyan)', 'var(--amber)', 'var(--purple)', 'var(--red)']

export default function TrainingPlanPage() {
  const { user } = useUser()
  const navigate = useNavigate()
  const [masterPlan, setMasterPlan] = useState<MasterPlan | null>(null)
  const [plan, setPlan] = useState<TrainingPlan | null>(null)
  const [profile, setProfile] = useState<MyProfile | null>(null)
  const [pageState, setPageState] = useState<PageState>('loading')
  const [planTab, setPlanTab] = useState<PlanTab>('overview')
  const requestKey = user || ''
  const [loadedKey, setLoadedKey] = useState('')

  const loadPlan = useCallback(() => {
    if (!user) return undefined
    let cancelled = false
    setLoadedKey('')

    Promise.all([
      getCurrentMasterPlan().catch(() => null),
      getTrainingPlan(user).catch(() => null),
      getMyProfile().catch(() => null),
    ]).then(([masterPlanData, planData, profileData]) => {
      if (cancelled) return
      setMasterPlan(masterPlanData)
      setPlan(planData)
      setProfile(profileData)

      if (masterPlanData || planData?.content) {
        setPageState('plan')
      } else if (hasCompleteRaceGoal(profileData)) {
        setPageState('plan')
      } else {
        setPageState('setup')
      }
    }).finally(() => {
      if (!cancelled) setLoadedKey(requestKey)
    })

    return () => { cancelled = true }
  }, [user, requestKey])

  useEffect(() => loadPlan(), [loadPlan])

  const display = useMemo(
    () => buildPlanDisplay(masterPlan, plan, profile),
    [masterPlan, plan, profile],
  )
  const loading = Boolean(requestKey && loadedKey !== requestKey)

  if (loading || pageState === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  if (pageState === 'setup') {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
        <ViewHead
          eyebrow="训练计划 · 起步"
          title="设置你的比赛目标"
          lede="设置目标赛事并同步历史数据，AI 教练会基于你的能力生成训练计划"
        />
        <TrainingPlanSetup
          onComplete={() => {
            setPageState('loading')
            loadPlan()
          }}
        />
      </div>
    )
  }

  if (!masterPlan && !plan?.content) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
        <ViewHead
          eyebrow="训练计划"
          title="训练计划生成中"
          lede="历史数据已同步完成，训练计划正在后台生成"
        />
        <div className="text-text-muted text-center py-20">
          <p>历史数据已同步完成，训练计划正在生成中</p>
          <p className="text-xs mt-2">请稍后刷新页面查看</p>
        </div>
      </div>
    )
  }

  return (
    <section className="plan-view animate-fade-in">
      <div className="view-head">
        <div>
          <div className="eyebrow">{display.eyebrow}</div>
          <h1>{display.title}</h1>
          <div className="lede">{display.lede}</div>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={() => navigate('/plan/adjust')}
            className="btn-primary"
          >
            <AdjustIcon />
            调整 / 重新生成计划
          </button>
        </div>
      </div>

      <div className="plan-sub-nav">
        <button
          type="button"
          onClick={() => setPlanTab('overview')}
          className={planTab === 'overview' ? 'active' : ''}
        >
          <ChartIcon />
          总览 · {display.totalWeeks || 0} 周
        </button>
        <button
          type="button"
          onClick={() => setPlanTab('weeks')}
          className={planTab === 'weeks' ? 'active' : ''}
        >
          <CalendarIcon />
          训练周列表 <span className="count">{display.totalWeeks || 0}</span>
        </button>
      </div>

      {planTab === 'overview' ? (
        <PlanOverview display={display} />
      ) : (
        <div>
          <div className="weeks-pane-intro">
            <div>
              <h2>训练周列表 · {display.totalWeeks || 0} 周</h2>
              <p>点击任意一周进入详情。<b className="green-text">本周</b> 也可以从左侧导航「本周训练」一键直达。</p>
            </div>
          </div>
          <WeeksGrid />
        </div>
      )}
    </section>
  )
}

function PlanOverview({ display }: { display: PlanDisplayModel }) {
  const defaultPhaseId = display.currentPhaseId || display.phases[0]?.id || ''
  const [selectedPhaseId, setSelectedPhaseId] = useState(defaultPhaseId)

  useEffect(() => {
    setSelectedPhaseId(defaultPhaseId)
  }, [defaultPhaseId, display.key])

  const selectedPhase = display.phases.find(phase => phase.id === selectedPhaseId) || display.phases[0]
  const selectedMilestones = selectedPhase
    ? display.milestones.filter(milestone => {
      if (milestone.phase_id === selectedPhase.id) return true
      return selectedPhase.milestoneIds.includes(milestone.id)
    })
    : []

  return (
    <div>
      <div className="plan-timeline">
        <div className="dash-card-head" style={{ marginBottom: 14 }}>
          <div className="t">{display.chartTitle}</div>
          <div className="meta">{display.chartMeta}</div>
        </div>
        <SeasonMileageBars bars={display.bars} axisLabels={display.axisLabels} />
      </div>

      <div className="plan-tabs" aria-label="训练阶段">
        {display.phases.map(phase => (
          <button
            key={phase.id}
            type="button"
            className={phase.id === selectedPhase?.id ? 'active' : ''}
            onClick={() => setSelectedPhaseId(phase.id)}
          >
            <span className="swatch" style={{ background: phase.color }} />
            {phase.name} · {phase.weekCount} 周
          </button>
        ))}
      </div>

      {selectedPhase ? (
        <div className="plan-body">
          <PhaseArticle
            display={display}
            phase={selectedPhase}
            milestones={selectedMilestones}
          />
          <aside className="plan-side">
            <SideCard title={`${selectedPhase.name} 关键课`} rows={keySessionRows(selectedPhase)} />
            <SideCard title={`${selectedPhase.name} 周量`} rows={weeklyRangeRows(selectedPhase, display.currentWeek)} />
            <SideCard title={`${selectedPhase.name} 里程碑`} valueTone="cyan" rows={milestoneRows(selectedMilestones)} />
            <SideCard title="训练原则" rows={principleRows(display.trainingPrinciples)} />
          </aside>
        </div>
      ) : (
        <div className="plan-prose">
          <h2>暂无训练阶段</h2>
          <p>当前接口没有返回可展示的训练阶段。</p>
        </div>
      )}
    </div>
  )
}

function PhaseArticle({
  display,
  phase,
  milestones,
}: {
  display: PlanDisplayModel
  phase: DisplayPhase
  milestones: MasterPlanMilestone[]
}) {
  const hasWeeklyRange = phase.weeklyLow !== null && phase.weeklyHigh !== null
  const principle = display.trainingPrinciples[0]

  return (
    <article className="plan-prose">
      <div className="eyebrow">{phase.name} · W{padWeek(phase.weekStart)}-W{padWeek(phase.weekEnd)}</div>
      <h2>{phase.focus || '阶段重点暂无结构化说明'}</h2>
      {display.source === 'master' ? (
        <p>
          这个阶段从 {formatDate(phase.startDate)} 到 {formatDate(phase.endDate)}，共 {phase.weekCount} 周。
          {hasWeeklyRange ? <> 周量范围为 <span className="accent">{phase.weeklyLow}-{phase.weeklyHigh} km</span>。</> : ' 当前接口没有返回这个阶段的周量范围。'}
        </p>
      ) : (
        <p>{display.fallbackSummary || '当前训练计划只返回 markdown 内容和阶段起止日期，页面不会补写样例训练数据。'}</p>
      )}
      {principle && <blockquote>&quot;{principle}&quot;</blockquote>}

      <h3><span className="num">01</span> 阶段范围</h3>
      <ul>
        <li><b>阶段周数</b> W{padWeek(phase.weekStart)}-W{padWeek(phase.weekEnd)} · {phase.weekCount} 周</li>
        <li><b>阶段日期</b> {formatDate(phase.startDate)} 至 {formatDate(phase.endDate)}</li>
        <li><b>当前进度</b> {display.currentWeek ? `W${padWeek(display.currentWeek)} / ${display.totalWeeks} 周` : '暂无当前周数据'}</li>
      </ul>

      <h3><span className="num">02</span> 关键课型</h3>
      {phase.keySessions.length > 0 ? (
        <ul>
          {phase.keySessions.map(session => <li key={session}><b>{session}</b></li>)}
        </ul>
      ) : (
        <p>当前接口没有返回这个阶段的关键课型。</p>
      )}

      <h3><span className="num">03</span> 里程碑与原则</h3>
      {milestones.length > 0 || display.trainingPrinciples.length > 0 ? (
        <ul>
          {milestones.map(milestone => (
            <li key={milestone.id}><b>{milestone.target}</b> · {formatDate(milestone.date)}</li>
          ))}
          {display.trainingPrinciples.map(item => (
            <li key={item}><b>原则</b> · {item}</li>
          ))}
        </ul>
      ) : (
        <p>当前接口没有返回里程碑或训练原则。</p>
      )}
    </article>
  )
}

function SeasonMileageBars({ bars, axisLabels }: { bars: MileageBar[]; axisLabels: string[] }) {
  return (
    <div className="mileage-chart">
      <div className="mileage-bars">
        {bars.length > 0 ? bars.map(bar => (
          <div
            key={bar.week}
            className={bar.className}
            style={{ height: `${bar.heightPct}%` }}
            title={bar.title}
          />
        )) : <div className="text-xs text-text-muted">暂无周量数据</div>}
      </div>
      <div className="mileage-axis">
        {axisLabels.map(label => <span key={label}>{label}</span>)}
      </div>
    </div>
  )
}

function SideCard({ title, rows, valueTone }: { title: string; rows: SideRow[]; valueTone?: 'cyan' }) {
  return (
    <div className="side-card">
      <h4>{title}</h4>
      {rows.map(({ marker, label, sub, value }) => (
        <div key={`${title}-${label}`} className="key-session">
          <span className="ico">{marker}</span>
          <span className="lbl">{label}<span className="sub">{sub}</span></span>
          <span className="km" style={valueTone === 'cyan' ? { color: 'var(--cyan)' } : undefined}>{value}</span>
        </div>
      ))}
    </div>
  )
}

function buildPlanDisplay(masterPlan: MasterPlan | null, fallbackPlan: TrainingPlan | null, profile: MyProfile | null): PlanDisplayModel {
  const target = readTargetProfile(profile)
  if (masterPlan) return buildMasterPlanDisplay(masterPlan, target)
  if (fallbackPlan?.content) return buildFallbackPlanDisplay(fallbackPlan, target)
  return buildEmptyDisplay(target)
}

function buildMasterPlanDisplay(masterPlan: MasterPlan, target: TargetProfile): PlanDisplayModel {
  const weeksFromApi = safePositiveInt(masterPlan.total_weeks)
  const phases = buildMasterPhases(masterPlan, weeksFromApi)
  const totalWeeks = weeksFromApi || Math.max(sum(phases.map(phase => phase.weekCount)), phases.at(-1)?.weekEnd || 0)
  const currentWeek = safePositiveInt(masterPlan.current_week_number)
  const bars = buildMileageBars(phases, totalWeeks, currentWeek)
  const peak = findPeakBar(bars)
  const raceName = target.raceName || '目标赛事'
  const ledeParts = [
    masterPlan.generated_by ? `由 ${masterPlan.generated_by} 生成` : '训练总纲',
    masterPlan.updated_at ? `更新 ${formatDate(masterPlan.updated_at)}` : '',
    Number.isFinite(masterPlan.version) ? `v${masterPlan.version}` : '',
  ].filter(Boolean)

  return {
    key: `${masterPlan.plan_id}:${masterPlan.version}:${masterPlan.updated_at}`,
    source: 'master',
    eyebrow: `${totalWeeks || phases.length} 周训练计划 · ${raceName}`,
    title: `从现在到${raceName} · 训练总览`,
    lede: ledeParts.join(' · ') || '当前训练总纲',
    totalWeeks,
    currentWeek,
    currentPhaseId: masterPlan.current_phase_id || phases[0]?.id || null,
    phases,
    milestones: masterPlan.milestones || [],
    trainingPrinciples: masterPlan.training_principles || [],
    bars,
    chartTitle: `${totalWeeks || bars.length} 周周量曲线`,
    chartMeta: peak ? `峰值 ${peak.km} km · W${padWeek(peak.week)} · 按阶段周量范围估算` : '暂无周量数据',
    axisLabels: buildAxisLabels(masterPlan.start_date, masterPlan.end_date || target.raceDate, totalWeeks, currentWeek, peak?.week || null),
    fallbackSummary: '',
  }
}

function buildFallbackPlanDisplay(plan: TrainingPlan, target: TargetProfile): PlanDisplayModel {
  let cursor = 1
  const phases: DisplayPhase[] = (plan.phases || []).map((phase, index) => {
    const weekCount = weeksBetween(phase.start, phase.end) || 1
    const displayPhase: DisplayPhase = {
      id: `fallback-${index}-${phase.name}`,
      name: phase.name || `阶段 ${index + 1}`,
      startDate: phase.start,
      endDate: phase.end,
      focus: phase.name || '训练阶段',
      weekStart: cursor,
      weekEnd: cursor + weekCount - 1,
      weekCount,
      weeklyLow: null,
      weeklyHigh: null,
      keySessions: [],
      milestoneIds: [],
      color: PHASE_COLORS[index % PHASE_COLORS.length],
    }
    cursor = displayPhase.weekEnd + 1
    return displayPhase
  })
  const totalWeeks = Math.max(cursor - 1, 0)
  const currentPhase = phases.find(phase => phase.name === plan.current_phase) || phases[0]
  const summary = firstMarkdownSentence(plan.content)
  const bars = buildMileageBars(phases, totalWeeks, null)
  const raceName = target.raceName || '目标赛事'

  return {
    key: `fallback:${plan.current_phase || ''}:${phases.map(phase => phase.id).join('|')}`,
    source: 'training-plan',
    eyebrow: `${totalWeeks || phases.length} 周训练计划 · ${raceName}`,
    title: `从现在到${raceName} · 训练总览`,
    lede: '来自训练计划文件 · 未返回 master plan 结构化总纲',
    totalWeeks,
    currentWeek: null,
    currentPhaseId: currentPhase?.id || null,
    phases,
    milestones: [],
    trainingPrinciples: [],
    bars,
    chartTitle: `${totalWeeks || phases.length} 周阶段长度`,
    chartMeta: '训练计划 API 未返回周量数据',
    axisLabels: buildAxisLabels(phases[0]?.startDate || '', target.raceDate || phases.at(-1)?.endDate || '', totalWeeks, null, null),
    fallbackSummary: summary,
  }
}

function buildEmptyDisplay(target: TargetProfile): PlanDisplayModel {
  const raceName = target.raceName || '目标赛事'
  return {
    key: 'empty',
    source: 'empty',
    eyebrow: `训练计划 · ${raceName}`,
    title: `从现在到${raceName} · 训练总览`,
    lede: '暂无训练计划数据',
    totalWeeks: 0,
    currentWeek: null,
    currentPhaseId: null,
    phases: [],
    milestones: [],
    trainingPrinciples: [],
    bars: [],
    chartTitle: '周量曲线',
    chartMeta: '暂无周量数据',
    axisLabels: [],
    fallbackSummary: '',
  }
}

function buildMasterPhases(masterPlan: MasterPlan, weeksFromApi: number | null): DisplayPhase[] {
  let cursor = 1
  const phases = (masterPlan.phases || []).map((phase, index) => {
    const weekCount = weeksBetween(phase.start_date, phase.end_date) || 1
    const displayPhase: DisplayPhase = {
      id: phase.id,
      name: phase.name || `阶段 ${index + 1}`,
      startDate: phase.start_date,
      endDate: phase.end_date,
      focus: phase.focus || '',
      weekStart: cursor,
      weekEnd: cursor + weekCount - 1,
      weekCount,
      weeklyLow: safeNumber(phase.weekly_distance_km_low),
      weeklyHigh: safeNumber(phase.weekly_distance_km_high),
      keySessions: phase.key_session_types || [],
      milestoneIds: phase.milestone_ids || [],
      color: PHASE_COLORS[index % PHASE_COLORS.length],
    }
    cursor = displayPhase.weekEnd + 1
    return displayPhase
  })

  const computedWeeks = cursor - 1
  if (weeksFromApi && phases.length > 0 && computedWeeks !== weeksFromApi) {
    const last = phases[phases.length - 1]
    last.weekEnd = weeksFromApi
    last.weekCount = Math.max(1, last.weekEnd - last.weekStart + 1)
  }
  return phases
}

function buildMileageBars(phases: DisplayPhase[], totalWeeks: number, currentWeek: number | null): MileageBar[] {
  const rawBars = phases.flatMap(phase => Array.from({ length: phase.weekCount }, (_, localIndex) => {
    const week = phase.weekStart + localIndex
    const km = interpolateWeeklyKm(phase, localIndex)
    return { week, km }
  })).filter(bar => !totalWeeks || bar.week <= totalWeeks)

  const maxKm = Math.max(...rawBars.map(bar => bar.km || 0), 1)
  return rawBars.map(bar => {
    const className = bar.week === currentWeek
      ? 'b current'
      : totalWeeks && bar.week === totalWeeks
        ? 'b race'
        : currentWeek && bar.week > currentWeek
          ? 'b future'
          : 'b'
    const heightPct = bar.km === null ? 42 : Math.max(8, Math.round((bar.km / maxKm) * 100))
    return {
      week: bar.week,
      km: bar.km,
      className,
      heightPct,
      title: bar.km === null ? `W${padWeek(bar.week)} 暂无周量数据` : `W${padWeek(bar.week)} ${bar.km}km`,
    }
  })
}

function interpolateWeeklyKm(phase: DisplayPhase, localIndex: number): number | null {
  if (phase.weeklyLow === null || phase.weeklyHigh === null) return null
  if (phase.weekCount <= 1) return Math.round(phase.weeklyHigh)
  const ratio = localIndex / (phase.weekCount - 1)
  return Math.round(phase.weeklyLow + ((phase.weeklyHigh - phase.weeklyLow) * ratio))
}

function findPeakBar(bars: MileageBar[]): MileageBar | null {
  return bars.reduce<MileageBar | null>((peak, bar) => {
    if (bar.km === null) return peak
    if (!peak || peak.km === null || bar.km > peak.km) return bar
    return peak
  }, null)
}

function buildAxisLabels(startDate: string, endDate: string, totalWeeks: number, currentWeek: number | null, peakWeek: number | null): string[] {
  const labels = new Map<string, string>()
  if (startDate) labels.set('start', `W01 ${formatShortDate(startDate)}`)
  if (currentWeek && currentWeek > 1 && currentWeek < totalWeeks) labels.set('current', `当前 W${padWeek(currentWeek)}`)
  if (peakWeek && peakWeek > 1 && peakWeek < totalWeeks && peakWeek !== currentWeek) labels.set('peak', `峰值 W${padWeek(peakWeek)}`)
  if (endDate) labels.set('end', `终点 ${formatShortDate(endDate)}`)
  return Array.from(labels.values())
}

function keySessionRows(phase: DisplayPhase): SideRow[] {
  if (phase.keySessions.length === 0) return emptyRows('暂无关键课型')
  return phase.keySessions.map((session, index) => ({
    marker: `K${index + 1}`,
    label: session,
    sub: `W${padWeek(phase.weekStart)}-W${padWeek(phase.weekEnd)}`,
    value: '重点',
  }))
}

function weeklyRangeRows(phase: DisplayPhase, currentWeek: number | null): SideRow[] {
  const range = phase.weeklyLow !== null && phase.weeklyHigh !== null ? `${phase.weeklyLow}-${phase.weeklyHigh} km` : '暂无数据'
  return [
    { marker: 'W', label: '周量范围', sub: `${formatDate(phase.startDate)} 至 ${formatDate(phase.endDate)}`, value: range },
    { marker: 'D', label: '阶段长度', sub: `W${padWeek(phase.weekStart)}-W${padWeek(phase.weekEnd)}`, value: `${phase.weekCount} 周` },
    { marker: 'N', label: '当前周', sub: 'master plan 返回值', value: currentWeek ? `W${padWeek(currentWeek)}` : '暂无' },
  ]
}

function milestoneRows(milestones: MasterPlanMilestone[]): SideRow[] {
  if (milestones.length === 0) return emptyRows('暂无里程碑')
  return milestones.map((milestone, index) => ({
    marker: `M${index + 1}`,
    label: milestone.target,
    sub: `${formatDate(milestone.date)} · ${milestone.type}`,
    value: milestone.completed_actual ? '完成' : '待完成',
  }))
}

function principleRows(principles: string[]): SideRow[] {
  if (principles.length === 0) return emptyRows('暂无训练原则')
  return principles.map((principle, index) => ({
    marker: `P${index + 1}`,
    label: principle,
    sub: '训练总纲原则',
    value: '原则',
  }))
}

function emptyRows(label: string): SideRow[] {
  return [{ marker: '-', label, sub: '接口未返回', value: '暂无' }]
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

function hasCompleteRaceGoal(profile: MyProfile | null): boolean {
  const target = readTargetProfile(profile)
  return Boolean(target.raceName && target.distance && target.raceDate && target.targetTime)
}

function stringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value.trim() : ''
}

function distanceLabel(value: string): string {
  const labels: Record<string, string> = { '5K': '5K', '10K': '10K', HM: '半马', FM: '全马' }
  return labels[value] || value
}

function firstMarkdownSentence(content: string | null): string {
  if (!content) return ''
  const line = content
    .split('\n')
    .map(item => item.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim())
    .find(Boolean)
  return line || ''
}

function safeNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function safePositiveInt(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null
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

function formatDate(value: string): string {
  const datePart = value.split('T')[0]
  return datePart || value
}

function formatShortDate(value: string): string {
  const date = parseDateOnly(value)
  if (!date) return value
  return `${date.getMonth() + 1}/${String(date.getDate()).padStart(2, '0')}`
}

function padWeek(week: number): string {
  return String(week).padStart(2, '0')
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function AdjustIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  )
}

function ChartIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M3 3v18h18" />
      <path d="M7 14l3-3 4 4 5-5" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  )
}
