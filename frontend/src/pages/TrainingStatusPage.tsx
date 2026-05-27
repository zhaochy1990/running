import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell, ComposedChart, Line, LineChart,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend, ReferenceLine,
} from 'recharts'
import {
  getHealth, getHrv, getStrideZones, getStrideTrainingLoad,
  type HealthRecord, type HRVSnapshot, type HrvDailyRecord,
  type StrideZonesResponse, type StrideTrainingLoadResponse,
} from '../api'
import { useUser } from '../UserContextValue'
import { aggregateWeeklyDose } from '../lib/weeklyLoad'
import ViewHead from '../components/ViewHead'

// Form color band matches HealthPage's STRIDE block originally — kept here as
// the single source of truth after the chart relocated.
function formColor(v: number | null): string {
  if (v == null) return '#8888a0'
  if (v >= 25) return '#ffab00'
  if (v >= 10) return '#00a85a'
  if (v >= -10) return '#8888a0'
  if (v >= -30) return '#0097a7'
  return '#d32f2f'
}

// Readiness gate is produced by `src/stride_core/training_load/core.py` as
// 'green' / 'yellow' / 'red'. Anything else gets neutral grey so an unexpected
// gate doesn't look like a STOP signal.
function readinessColor(gate: string | null): string {
  const map: Record<string, string> = {
    green: '#00a85a',
    yellow: '#e68a00',
    red: '#d32f2f',
  }
  return gate ? (map[gate] ?? '#8888a0') : '#8888a0'
}

function readinessLabel(gate: string | null): string {
  const map: Record<string, string> = {
    green: '可进行强度训练',
    yellow: '注意，建议减量',
    red: '建议停训恢复',
  }
  return gate ? (map[gate] ?? gate) : '—'
}

function readinessGateLabel(gate: string | null): string {
  const map: Record<string, string> = {
    green: '绿灯',
    yellow: '黄灯',
    red: '红灯',
  }
  return gate ? (map[gate] ?? gate) : '—'
}

const AXIS_TICK = { fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }
const TOOLTIP_STYLE = {
  contentStyle: { background: '#ffffff', border: '1px solid #d8dae5', borderRadius: 8, fontFamily: 'JetBrains Mono', fontSize: 12, color: '#1a1c2e' },
  labelStyle: { color: '#8888a0' },
}
const GRID_STYLE = { stroke: '#e8eaf0', strokeDasharray: '3 3' }

type DaysWindow = 14 | 30 | 60 | 90

function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return iso
  return `${parseInt(iso.slice(5, 7), 10)}/${parseInt(iso.slice(8, 10), 10)}`
}

export default function TrainingStatusPage() {
  const { user } = useUser()
  const [days, setDays] = useState<DaysWindow>(30)
  const [health, setHealth] = useState<{ health: HealthRecord[]; rhr_baseline: number | null; hrv_snapshot: HRVSnapshot | null } | null>(null)
  const [hrv, setHrv] = useState<{ hrv: HrvDailyRecord[] } | null>(null)
  const [zones, setZones] = useState<StrideZonesResponse | null>(null)
  const [load, setLoad] = useState<StrideTrainingLoadResponse | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoaded(false)
    setError(null)
    // The 8-week trend chart needs ≥ 56 days to fill all buckets, regardless
    // of the user's chosen daily-chart window. Fetch the larger of the two.
    const loadFetchDays = Math.max(days, 56)
    Promise.all([
      getHealth(user, 90),
      getHrv(user, 90),
      getStrideZones(user),
      getStrideTrainingLoad(user, loadFetchDays),
    ])
      .then(([h, hv, z, ld]) => {
        if (cancelled) return
        setHealth({ health: h.health, rhr_baseline: h.rhr_baseline, hrv_snapshot: h.hrv ?? null })
        setHrv({ hrv: hv.hrv })
        setZones(z)
        setLoad(ld)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => { cancelled = true }
  }, [user, days])

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <div className="flex items-start justify-between gap-4 mb-4">
        <ViewHead eyebrow="STRIDE 自研算法" title="训练状态" lede="Threshold · Zones · Training Load" />
        <TimeRangeToggle value={days} onChange={setDays} />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm font-mono">
          加载失败：{error}
        </div>
      )}

      <MetricsRow health={health} hrv={hrv} zones={zones} />
      <TrendsRow health={health} hrv={hrv} days={days} />
      <ZonesRow zones={zones} />
      <TrainingLoadSection load={load} dailyWindowDays={days} />
      <DataStatusFooter zones={zones} load={load} />
    </div>
  )
}

function TimeRangeToggle({ value, onChange }: { value: DaysWindow; onChange: (d: DaysWindow) => void }) {
  const opts: DaysWindow[] = [14, 30, 60, 90]
  return (
    <div className="inline-flex rounded-md border border-border-subtle bg-bg-card p-0.5">
      {opts.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          className={`px-3 py-1 text-xs font-mono rounded ${
            value === d ? 'bg-accent-green/15 text-accent-green' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  )
}

// === Task 8: MetricsRow ===
function MetricCard({
  label, sublabel, value, unit, baseline, color, help,
}: {
  label: string
  sublabel: string
  value: string
  unit: string
  baseline?: string | null
  color: string
  help?: React.ReactNode
}) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 flex flex-col gap-1 overflow-visible">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-mono text-text-muted">{label}</div>
        {help && (
          <div className="group relative">
            <div className="w-4 h-4 rounded-full border border-border-subtle text-[10px] font-mono text-text-muted cursor-help flex items-center justify-center hover:border-text-secondary hover:text-text-secondary transition-colors">?</div>
            <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity absolute right-0 top-6 z-50 w-64 bg-bg-card border border-border-subtle rounded-lg p-3 shadow-lg text-xs text-text-primary font-normal leading-relaxed whitespace-pre-line pointer-events-none">
              {help}
            </div>
          </div>
        )}
      </div>
      <div className="text-[10px] font-mono text-text-faint">{sublabel}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <span className="text-2xl font-mono font-medium" style={{ color }}>{value}</span>
        <span className="text-xs font-mono text-text-muted">{unit}</span>
      </div>
      {baseline != null && (
        <div className="text-[10px] font-mono text-text-muted mt-0.5">{baseline}</div>
      )}
    </div>
  )
}

function MetricsRow({
  health, hrv, zones,
}: {
  health: { health: HealthRecord[]; rhr_baseline: number | null; hrv_snapshot: HRVSnapshot | null } | null
  hrv: { hrv: HrvDailyRecord[] } | null
  zones: StrideZonesResponse | null
}) {
  const latestRhrRow = health?.health.find((r) => r.rhr != null) ?? null
  const latestRhr = latestRhrRow?.rhr ?? null
  const latestRhrDate = latestRhrRow?.date
    ? formatDateShort(
        latestRhrRow.date.length === 8
          ? `${latestRhrRow.date.slice(0, 4)}-${latestRhrRow.date.slice(4, 6)}-${latestRhrRow.date.slice(6, 8)}`
          : latestRhrRow.date,
      )
    : null
  const rhrBaseline = health?.rhr_baseline ?? null
  const latestHrvRow = hrv?.hrv.slice().reverse().find((r) => r.last_night_avg != null) ?? null
  const latestHrv = latestHrvRow?.last_night_avg ?? null
  const latestHrvDate = latestHrvRow?.date ? formatDateShort(latestHrvRow.date) : null
  const hrvLow = health?.hrv_snapshot?.hrv_normal_low ?? null
  const hrvHigh = health?.hrv_snapshot?.hrv_normal_high ?? null
  const hrvBaseline = hrvLow != null && hrvHigh != null ? `正常 ${hrvLow}-${hrvHigh} ms` : null
  const threshold = zones?.threshold

  const pacePerKm = threshold?.pace_per_km_sec
  const paceStr = pacePerKm != null ? `${Math.floor(pacePerKm / 60)}:${String(pacePerKm % 60).padStart(2, '0')}` : '—'
  const hrStr = threshold?.hr_bpm != null ? String(Math.round(threshold.hr_bpm)) : '—'

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <MetricCard
        label="静息心率(RHR)" sublabel={latestRhrDate ? `${latestRhrDate} · 手表读数` : '手表读数'}
        value={latestRhr != null ? String(latestRhr) : '—'}
        unit="bpm"
        baseline={rhrBaseline != null ? `基线 ${rhrBaseline} bpm` : null}
        color="#0097a7"
        help={<><strong>清晨静息心率</strong>。反映心血管恢复与自主神经平衡。{'\n\n'}使用方法：{'\n'}• 接近基线 = 恢复良好{'\n'}• 高出基线 3+ bpm 持续 3 天 = 疲劳累积{'\n'}• 高出 8+ = 生病 / 过劳，立即休息{'\n'}• 基线按过去 90 天 RHR 低 10 分位动态计算</>}
      />
      <MetricCard
        label="心率变异性(HRV)" sublabel={latestHrvDate ? `${latestHrvDate} · 手表读数` : '手表读数'}
        value={latestHrv != null ? String(latestHrv) : '—'}
        unit="ms"
        baseline={hrvBaseline}
        color="#7a4dd4"
        help={<><strong>睡眠心率变异性</strong>。反映副交感神经恢复程度。{'\n\n'}使用方法：{'\n'}• 在正常范围内稳定 = 恢复充分{'\n'}• 下降 10% = 黄灯，注意{'\n'}• 下降 20%+ = 红灯，跳过高质量{'\n'}• 高于上限 = 深度恢复 / 副交感活跃{'\n'}• 正常范围按 dashboard 个人 baseline</>}
      />
      <MetricCard
        label="阈值配速" sublabel="STRIDE Threshold Pace"
        value={paceStr}
        unit="/km"
        baseline={threshold?.speed_confidence ? `置信 ${threshold.speed_confidence}` : null}
        color="#00a85a"
        help={<><strong>STRIDE 自研阈值配速</strong>。乳酸阈附近的可持续配速，是所有 6 个配速区间的锚点。{'\n\n'}使用方法：{'\n'}• 节奏跑配速 ≈ 阈值 ± 5 s/km{'\n'}• 长距离配速 = 阈值 + 30 ~ 60 s/km{'\n'}• 由近 90 天 HR-pace 回归 + tempo 段落识别得出{'\n'}• 置信度低 = 样本不足，需要更多 tempo / LT 课</>}
      />
      <MetricCard
        label="阈值心率" sublabel="STRIDE Threshold HR"
        value={hrStr}
        unit="bpm"
        baseline={threshold?.hr_confidence ? `置信 ${threshold.hr_confidence}` : null}
        color="#d97706"
        help={<><strong>STRIDE 自研阈值心率</strong>。乳酸阈附近的可持续心率，是 6 个心率区间的锚点。{'\n\n'}使用方法：{'\n'}• 比赛全马目标 HR ≈ 阈值 − 5{'\n'}• 节奏跑 HR = 阈值 ± 3{'\n'}• 间歇课 HR 可短暂超过 阈值 + 5{'\n'}• 置信度低 = 缺少结构化课次</>}
      />
    </div>
  )
}

// === Task 9: TrendsRow ===
function ChartCard({ title, sublabel, children }: { title: string; sublabel: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4">
      <div className="text-xs font-mono text-text-muted">{title}</div>
      <div className="text-[10px] font-mono text-text-faint mb-2">{sublabel}</div>
      {children}
    </div>
  )
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-[200px] text-xs font-mono text-text-muted">{text}</div>
  )
}

function TrendsRow({
  health, hrv, days,
}: {
  health: { health: HealthRecord[]; rhr_baseline: number | null } | null
  hrv: { hrv: HrvDailyRecord[] } | null
  days: DaysWindow
}) {
  const rhrData = (health?.health ?? [])
    .slice()
    .reverse()
    .filter((r) => r.rhr != null)
    .slice(-days)
    .map((r) => ({
      date: r.date,
      dateLabel: formatDateShort(r.date.length === 8 ? `${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}` : r.date),
      rhr: r.rhr,
    }))

  const hrvData = (hrv?.hrv ?? [])
    .slice()
    .filter((r) => r.last_night_avg != null)
    .slice(-days)
    .map((r) => ({
      date: r.date,
      dateLabel: formatDateShort(r.date),
      hrv: r.last_night_avg,
    }))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <ChartCard title="RHR 趋势" sublabel={`最近 ${days} 天 · 手表读数`}>
        {rhrData.length === 0 ? (
          <EmptyChart text="暂无 RHR 数据" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={rhrData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} domain={['dataMin - 2', 'dataMax + 2']} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="rhr" stroke="#0097a7" fill="#0097a7" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
      <ChartCard title="HRV 趋势" sublabel={`最近 ${days} 天 · 手表读数`}>
        {hrvData.length === 0 ? (
          <EmptyChart text="暂无 HRV 数据" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={hrvData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} domain={['dataMin - 5', 'dataMax + 5']} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="hrv" stroke="#7a4dd4" fill="#7a4dd4" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  )
}

// === Task 10: ZonesRow ===
function EmptyZones() {
  return (
    <div className="text-xs font-mono text-text-muted py-6 text-center">
      暂无 STRIDE 校准数据
      <br />
      需先完成一定次数的跑步活动
    </div>
  )
}

// Format a zone bound pair into a single "区间" string.
//
// Pace zones order pace strings from slower (lower_pace, e.g. 6:42) to faster
// (upper_pace, e.g. 5:58). Open-ended zones — recovery has no slow cap, the
// fastest zone has no fast cap — render with ≤ / ≥ relative to the only bound
// present. HR zones use the same shape, with bpm rising from recovery up.
function formatZoneRange<T extends string | number>(
  lower: T | null,
  upper: T | null,
): string {
  if (lower != null && upper != null) return `${lower} – ${upper}`
  if (upper != null) return `≤ ${upper}`
  if (lower != null) return `≥ ${lower}`
  return '—'
}

function ZonesRow({ zones }: { zones: StrideZonesResponse | null }) {
  const hasData = !!zones?.threshold && zones.pace_zones.length > 0 && zones.hr_zones.length > 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <ChartCard title="配速区间" sublabel="STRIDE-derived from threshold pace">
        {hasData ? (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-faint border-b border-border-subtle">
                <th className="text-left py-1">Zone</th>
                <th className="text-left py-1">名称</th>
                <th className="text-right py-1">区间</th>
              </tr>
            </thead>
            <tbody>
              {zones!.pace_zones.map((z) => (
                <tr key={z.name} className="border-b border-border-subtle/50 last:border-0">
                  <td className="py-1.5 text-accent-green">{z.name}</td>
                  <td className="py-1.5 text-text-primary">{z.label}</td>
                  <td className="py-1.5 text-right text-text-muted">{formatZoneRange(z.lower_pace, z.upper_pace)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyZones />
        )}
      </ChartCard>

      <ChartCard title="心率区间" sublabel="STRIDE-derived from threshold HR">
        {hasData ? (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-faint border-b border-border-subtle">
                <th className="text-left py-1">Zone</th>
                <th className="text-left py-1">名称</th>
                <th className="text-right py-1">区间</th>
              </tr>
            </thead>
            <tbody>
              {zones!.hr_zones.map((z) => (
                <tr key={z.name} className="border-b border-border-subtle/50 last:border-0">
                  <td className="py-1.5 text-accent-amber">{z.name}</td>
                  <td className="py-1.5 text-text-primary">{z.label}</td>
                  <td className="py-1.5 text-right text-text-muted">{formatZoneRange(z.lower_bpm, z.upper_bpm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyZones />
        )}
      </ChartCard>
    </div>
  )
}

// === Task 11: TrainingLoadSection ===
function LoadStat({ label, value, color, help }: {
  label: string; value: string; color: string; help?: React.ReactNode
}) {
  return (
    <div className="flex flex-col overflow-visible">
      <div className="flex items-center gap-1.5">
        <div className="text-[10px] font-mono text-text-faint">{label}</div>
        {help && (
          <div className="group relative">
            <div className="w-3.5 h-3.5 rounded-full border border-border-subtle text-[9px] font-mono text-text-muted cursor-help flex items-center justify-center hover:border-text-secondary hover:text-text-secondary transition-colors">?</div>
            <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity absolute left-0 top-5 z-50 w-64 bg-bg-card border border-border-subtle rounded-lg p-3 shadow-lg text-xs text-text-primary font-normal leading-relaxed whitespace-pre-line pointer-events-none">
              {help}
            </div>
          </div>
        )}
      </div>
      <div className="text-lg font-mono font-medium" style={{ color }}>{value}</div>
    </div>
  )
}

function TrainingLoadSection({ load, dailyWindowDays }: {
  load: StrideTrainingLoadResponse | null
  dailyWindowDays: number
}) {
  const cur = load?.current
  // Daily chart respects the user's window; weekly chart always uses the
  // full series the parent fetched (≥ 56 days) so all 8 buckets fill.
  const rawSeries = load?.series ?? []
  const series = rawSeries.slice(-dailyWindowDays).map((r) => ({
    ...r,
    dateLabel: formatDateShort(r.date),
  }))
  const weeklySeries = useMemo(
    () => aggregateWeeklyDose(rawSeries).map((b) => ({
      ...b,
      totalDose: Math.round(b.totalDose * 10) / 10,
    })),
    [rawSeries],
  )

  const stateLabel = (() => {
    const ratio = cur?.load_ratio
    if (ratio == null) return '—'
    if (ratio < 0.8) return '恢复期'
    if (ratio < 1.0) return '正常训练'
    if (ratio < 1.3) return '产出期'
    return '过度负荷'
  })()

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 mb-6">
      <div className="text-xs font-mono text-text-muted mb-2">训练负荷（STRIDE）</div>
      {!cur ? (
        <div className="text-xs font-mono text-text-muted py-6 text-center">暂无训练负荷数据</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
            <LoadStat
              label="训练负荷(Dose)"
              value={cur.training_dose?.toFixed(0) ?? '—'}
              color="#e68a00"
              help={<><strong>当日 STRIDE 客观训练剂量</strong>。基于配速 × 心率区间累积的应激分。{'\n\n'}使用方法：{'\n'}• 是 Acute / Chronic 的输入；单日值高 = 当天硬课{'\n'}• 日累计 → 7 天平均 = Acute Load{'\n'}• 用于横向跨课次量化训练应激而非主观 RPE</>}
            />
            <LoadStat
              label="急性负荷(Acute)"
              value={cur.acute_load?.toFixed(1) ?? '—'}
              color="#d97706"
              help={<><strong>近 7 天指数加权训练剂量</strong>。代表当前训练应激强度。{'\n\n'}使用方法：{'\n'}• 高于慢性负荷 → 负荷累积期{'\n'}• 低于慢性负荷 → 恢复 / 减量期{'\n'}• 单日突增 = 比赛或高质量课{'\n'}• 与慢性负荷波浪式交替为健康节奏</>}
            />
            <LoadStat
              label="慢性负荷(Chronic)"
              value={cur.chronic_load?.toFixed(1) ?? '—'}
              color="#0097a7"
              help={<><strong>近 42 天指数加权训练剂量</strong>。代表长期体能基线。{'\n\n'}使用方法：{'\n'}• 缓慢上升 = 健康进步{'\n'}• 持平 = 维持期{'\n'}• 下降 = 体能流失，需加量{'\n'}• 上升过快（每周 +8 以上）= 易受伤</>}
            />
            <LoadStat
              label="竞技状态(Form)"
              value={cur.form != null ? (cur.form > 0 ? `+${cur.form.toFixed(1)}` : cur.form.toFixed(1)) : '—'}
              color={cur.form != null && cur.form < -10 ? '#d32f2f' : '#00a85a'}
              help={<><strong>Form = 慢性负荷 − 急性负荷</strong>。衡量已从近期训练中恢复多少。{'\n\n'}使用方法：{'\n'}• +10 ~ +25 = 比赛就绪甜区{'\n'}• −10 ~ +10 = 过渡区，维持或轻松日{'\n'}• −30 ~ −10 = 正常训练刺激{'\n'}• 低于 −30 = 过度负荷，必须减量{'\n'}• 高于 +25 = 减量过多，开始流失体能</>}
            />
            <LoadStat
              label="负荷比(Ratio)"
              value={cur.load_ratio?.toFixed(2) ?? '—'}
              color="#7a4dd4"
              help={<><strong>ACWR = 急性 / 慢性</strong>。衡量近期负荷相对长期基线。{'\n\n'}使用方法：{'\n'}• 0.8 – 1.1 = 健康训练区{'\n'}• 高于 1.2 = 过度应激，减量{'\n'}• 高于 1.5 = 极高风险，强制休息{'\n'}• 低于 0.7 = 流失体能，需加量{'\n'}• 4 周块均值 ≈ 1.0 为理想周期化</>}
            />
            <LoadStat
              label="状态"
              value={stateLabel}
              color="#1a1c2e"
              help={<><strong>由负荷比衍生的状态分类</strong>，给出今日训练决策参考。{'\n\n'}阈值：{'\n'}• 恢复期：ratio &lt; 0.8{'\n'}• 正常训练：0.8 – 1.0{'\n'}• 产出期：1.0 – 1.3{'\n'}• 过度负荷：&gt; 1.3</>}
            />
          </div>
          <div className="text-[11px] font-mono text-text-muted mb-2 flex items-center flex-wrap gap-x-1">
            <span>训练就绪：</span>
            <span
              className="px-1.5 py-0.5 rounded font-semibold"
              style={{ color: readinessColor(cur.readiness_gate), backgroundColor: `${readinessColor(cur.readiness_gate)}15` }}
            >
              {cur.readiness_gate ? readinessGateLabel(cur.readiness_gate) : '—'}
              {cur.readiness_gate && ` · ${readinessLabel(cur.readiness_gate)}`}
            </span>
            {cur.readiness_reasons.length > 0 && (
              <span className="text-text-faint">· {cur.readiness_reasons.join(' · ')}</span>
            )}
          </div>
          {series.length > 0 && (
            <>
              <div className="text-[11px] font-mono text-text-muted mb-2 mt-1">STRIDE 客观负荷 · 训练负荷 (右轴) / 慢性负荷 / 急性负荷 (左轴)</div>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradTrainingLoadChronic" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00a85a" stopOpacity={0.18} />
                      <stop offset="95%" stopColor="#00a85a" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...GRID_STYLE} />
                  <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
                  {/* Left axis: Acute / Chronic EWMA (~10-80 typical) */}
                  <YAxis yAxisId="load" tick={AXIS_TICK} />
                  {/* Right axis: per-day Dose (~50-250 typical for hard sessions) — separated so a single
                      race-week dose spike doesn't compress the Acute / Chronic curves into a flat ribbon. */}
                  <YAxis yAxisId="dose" orientation="right" tick={AXIS_TICK} />
                  <Tooltip {...TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                  <Bar yAxisId="dose" dataKey="training_dose" name="训练负荷" fill="#e68a00" fillOpacity={0.55} maxBarSize={14} />
                  <Area yAxisId="load" type="monotone" dataKey="chronic_load" name="慢性负荷" stroke="#00a85a" strokeWidth={2} fill="url(#gradTrainingLoadChronic)" dot={false} activeDot={{ r: 3, fill: '#00a85a', stroke: '#fff', strokeWidth: 2 }} />
                  <Line yAxisId="load" type="monotone" dataKey="acute_load" name="急性负荷" stroke="#0097a7" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={{ r: 3, fill: '#0097a7', stroke: '#fff', strokeWidth: 2 }} />
                </ComposedChart>
              </ResponsiveContainer>

              <div className="mt-4">
                <p className="text-[11px] font-mono text-text-muted mb-2 ml-1">竞技状态 Form (慢性负荷 − 急性负荷)</p>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={series} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                    <CartesianGrid {...GRID_STYLE} />
                    <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
                    <YAxis tick={AXIS_TICK} />
                    <Tooltip
                      {...TOOLTIP_STYLE}
                      formatter={(v: unknown) => [typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}` : `${v}`, '竞技状态']}
                    />
                    <ReferenceLine y={0} stroke="#8888a0" strokeWidth={1} />
                    <Bar dataKey="form" name="竞技状态">
                      {series.map((entry, idx) => (
                        <Cell key={idx} fill={formColor(entry.form)} fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-4">
                <p className="text-[11px] font-mono text-text-muted mb-2 ml-1">8 周负荷趋势 · 8-Week Load Trend (每周 Dose 累加)</p>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={weeklySeries} margin={{ top: 5, right: 10, bottom: 0, left: -5 }}>
                    <CartesianGrid {...GRID_STYLE} />
                    <XAxis dataKey="weekLabel" tick={AXIS_TICK} />
                    <YAxis tick={AXIS_TICK} />
                    <Tooltip
                      {...TOOLTIP_STYLE}
                      labelFormatter={(label: unknown, payload) => {
                        const row = payload?.[0]?.payload as { weekStart?: string } | undefined
                        return row?.weekStart ? `周一 ${row.weekStart}` : `${label}`
                      }}
                      formatter={(value: unknown, _name, ctx) => {
                        const row = (ctx as { payload?: { activeDays?: number } } | undefined)?.payload
                        const dose = typeof value === 'number' ? value.toFixed(1) : `${value}`
                        return [`${dose}（${row?.activeDays ?? 0} 天）`, '周剂量']
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="totalDose"
                      name="周剂量"
                      stroke="#e68a00"
                      strokeWidth={2}
                      dot={{ r: 3.5, fill: '#e68a00', stroke: '#fff', strokeWidth: 1.5 }}
                      activeDot={{ r: 5, fill: '#e68a00', stroke: '#fff', strokeWidth: 2 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// === Task 12: DataStatusFooter ===
function DataStatusFooter({
  zones, load,
}: {
  zones: StrideZonesResponse | null
  load: StrideTrainingLoadResponse | null
}) {
  return (
    <div className="text-[10px] font-mono text-text-faint border-t border-border-subtle pt-3 mt-4 space-y-0.5">
      <div>
        Calibration: {zones?.threshold?.as_of_date ?? '—'} · 来源：STRIDE 自研算法
      </div>
      <div>Training load latest: {load?.current?.date ?? '—'}</div>
      <div>RHR / HRV: 来自手表原始读数（COROS / Garmin）</div>
    </div>
  )
}
