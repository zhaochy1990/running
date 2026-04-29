import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, Line, BarChart, Bar, Cell,
  ComposedChart,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts'
import { getHealth, getPMC, type HealthRecord, type PMCRecord, type PMCSummary, type HRVSnapshot } from '../api'
import { useUser } from '../UserContextValue'

function formatDate(dateStr: string): string {
  if (!dateStr) return dateStr
  // YYYYMMDD → M/D
  if (dateStr.length === 8) {
    const m = parseInt(dateStr.slice(4, 6), 10)
    const d = parseInt(dateStr.slice(6, 8), 10)
    return `${m}/${d}`
  }
  return dateStr
}

const AXIS_TICK = { fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }
const TOOLTIP_STYLE = {
  contentStyle: { background: '#ffffff', border: '1px solid #d8dae5', borderRadius: 8, fontFamily: 'JetBrains Mono', fontSize: 12, color: '#1a1c2e' },
  labelStyle: { color: '#8888a0' },
}
const GRID_STYLE = { stroke: '#e8eaf0', strokeDasharray: '3 3' }

function fatigueColor(v: number | null): string {
  if (v == null) return '#8888a0'
  if (v < 40) return '#00a85a'
  if (v < 50) return '#0097a7'
  if (v < 60) return '#ffab00'
  return '#d32f2f'
}

function ratioColor(v: number | null): string {
  if (v == null) return '#8888a0'
  if (v < 0.7) return '#0097a7'
  if (v <= 1.0) return '#00a85a'
  if (v <= 1.2) return '#ffab00'
  return '#d32f2f'
}

function loadStateLabel(state: string | null): string {
  const map: Record<string, string> = { Low: '低', Optimal: '最佳', High: '偏高', 'Very High': '很高' }
  return state ? (map[state] || state) : '—'
}

function loadStateColor(state: string | null): string {
  const map: Record<string, string> = { Low: '#0097a7', Optimal: '#00a85a', High: '#ffab00', 'Very High': '#d32f2f' }
  return state ? (map[state] || '#8888a0') : '#8888a0'
}

function tsbColor(v: number | null): string {
  if (v == null) return '#8888a0'
  if (v >= 25) return '#ffab00'
  if (v >= 10) return '#00a85a'
  if (v >= -10) return '#8888a0'
  if (v >= -30) return '#0097a7'
  return '#d32f2f'
}

function tsbZoneLabel(zone: string | null): string {
  const map: Record<string, string> = {
    overtaper: '减量过多', race_ready: '比赛就绪', neutral: '过渡区',
    training: '正常训练', overreaching: '过度负荷',
  }
  return zone ? (map[zone] || zone) : '—'
}

function tsbZoneColor(zone: string | null): string {
  const map: Record<string, string> = {
    overtaper: '#ffab00', race_ready: '#00a85a', neutral: '#8888a0',
    training: '#0097a7', overreaching: '#d32f2f',
  }
  return zone ? (map[zone] || '#8888a0') : '#8888a0'
}

export default function HealthPage() {
  const { user } = useUser()
  const [records, setRecords] = useState<HealthRecord[]>([])
  const [hrv, setHrv] = useState<HRVSnapshot | null>(null)
  const [rhrBaseline, setRhrBaseline] = useState<number | null>(null)
  const [pmcData, setPmcData] = useState<PMCRecord[]>([])
  const [pmcSummary, setPmcSummary] = useState<PMCSummary | null>(null)
  const [days, setDays] = useState(30)
  const [pmcDays, setPmcDays] = useState(90)
  const requestKey = user ? `${user}:${days}:${pmcDays}` : ''
  const [loadedKey, setLoadedKey] = useState('')
  const loading = Boolean(requestKey && loadedKey !== requestKey)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    Promise.all([
      getHealth(user, days),
      getPMC(user, pmcDays),
    ])
      .then(([healthData, pmcResult]) => {
        if (cancelled) return
        setRecords(healthData.health)
        setHrv(healthData.hrv || null)
        setRhrBaseline(healthData.rhr_baseline ?? null)
        setPmcData(pmcResult.pmc)
        setPmcSummary(pmcResult.summary)
      })
      .finally(() => {
        if (!cancelled) setLoadedKey(requestKey)
      })
    return () => {
      cancelled = true
    }
  }, [days, pmcDays, requestKey, user])

  // Records come newest first; reverse for charts
  const chartData = [...records].reverse().map((r) => ({
    ...r,
    dateLabel: formatDate(r.date),
  }))

  // PMC data is already chronological
  const pmcChartData = pmcData.map((r) => ({
    ...r,
    dateLabel: formatDate(r.date),
  }))

  const latest = records[0] // newest

  return (
        <div className="max-w-6xl mx-auto px-8 py-8">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-6 h-6 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
            </div>
          ) : (
            <div className="animate-fade-in">
              {/* Header */}
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h1 className="text-2xl font-bold text-text-primary tracking-tight">身体指标</h1>
                  <p className="text-xs text-text-muted mt-1">Daily Health Metrics</p>
                </div>
                <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg">
                  {[14, 30, 60, 90].map((d) => (
                    <button
                      key={d}
                      onClick={() => setDays(d)}
                      className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-all ${
                        days === d ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {d}天
                    </button>
                  ))}
                </div>
              </div>

              {/* Metric Cards */}
              {latest && <MetricCards latest={latest} hrv={hrv} rhrBaseline={rhrBaseline} />}

              {/* Charts 2x2 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <ChartCard title="静息心率" subtitle="Resting Heart Rate">
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        <linearGradient id="gradRHR" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#00a85a" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#00a85a" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                      <YAxis domain={['dataMin - 3', 'dataMax + 3']} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v} bpm`, 'RHR']} />
                      <ReferenceLine y={47} stroke="#00a85a" strokeDasharray="4 4" strokeOpacity={0.5} />
                      <ReferenceLine y={50} stroke="#ffab00" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <ReferenceLine y={55} stroke="#d32f2f" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <Area type="monotone" dataKey="rhr" stroke="#00a85a" strokeWidth={1.5} fill="url(#gradRHR)" dot={false} activeDot={{ r: 3, fill: '#00a85a', stroke: '#1e1e2e', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="疲劳趋势" subtitle="Fatigue Index">
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        {/* Y-axis color gradient: green(<40) → cyan(40-50) → amber(50-60) → red(>60) */}
                        {/* Domain [20,70]: 70=top(0%), 20=bottom(100%) */}
                        <linearGradient id="fatigueStroke" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#d32f2f" />
                          <stop offset="20%" stopColor="#d32f2f" />
                          <stop offset="20%" stopColor="#e68a00" />
                          <stop offset="40%" stopColor="#e68a00" />
                          <stop offset="40%" stopColor="#0097a7" />
                          <stop offset="60%" stopColor="#0097a7" />
                          <stop offset="60%" stopColor="#00a85a" />
                          <stop offset="100%" stopColor="#00a85a" />
                        </linearGradient>
                        <linearGradient id="gradFatigue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#d32f2f" stopOpacity={0.15} />
                          <stop offset="40%" stopColor="#e68a00" stopOpacity={0.1} />
                          <stop offset="60%" stopColor="#0097a7" stopOpacity={0.08} />
                          <stop offset="100%" stopColor="#00a85a" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                      <YAxis domain={[20, 70]} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => {
                        const n = Number(v)
                        const label = n < 40 ? '已恢复' : n < 50 ? '正常' : n < 60 ? '疲劳' : '高疲劳'
                        return [`${v} (${label})`, '疲劳值']
                      }} />
                      <ReferenceLine y={40} stroke="#00a85a" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: '恢复', position: 'right', fill: '#00a85a', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                      <ReferenceLine y={50} stroke="#e68a00" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: '疲劳', position: 'right', fill: '#e68a00', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                      <ReferenceLine y={60} stroke="#d32f2f" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: '高疲劳', position: 'right', fill: '#d32f2f', fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                      <Area type="monotone" dataKey="fatigue" stroke="url(#fatigueStroke)" strokeWidth={2} fill="url(#gradFatigue)" dot={false} activeDot={{ r: 4, fill: '#e68a00', stroke: '#ffffff', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="训练负荷比" subtitle="Training Load Ratio (ATI/CTI)">
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                      <YAxis domain={[0, 'dataMax + 0.3']} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [typeof v === 'number' ? v.toFixed(2) : `${v}`, '负荷比']} />
                      <ReferenceLine y={0.8} stroke="#00a85a" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <ReferenceLine y={1.0} stroke="#ffab00" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <ReferenceLine y={1.2} stroke="#d32f2f" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <Bar dataKey="training_load_ratio" radius={[2, 2, 0, 0]} maxBarSize={12}>
                        {chartData.map((entry, i) => (
                          <Cell key={i} fill={ratioColor(entry.training_load_ratio)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

              {/* PMC Section */}
              {pmcSummary && (
                <div className="mb-6">
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
                    <MetricCard
                      label="体能" sublabel="CTI (Fitness)"
                      value={pmcSummary.current_cti != null ? `${pmcSummary.current_cti}` : '—'} unit=""
                      color="#00a85a" detail="42天慢性负荷"
                      help={<><strong>慢性训练负荷</strong>（42天加权平均），代表长期累积的体能基线。{'\n\n'}使用方法：{'\n'}• 缓慢上升（每4周 +8~+12）= 健康进步{'\n'}• 水平不动 = 维持期{'\n'}• 下降 = 体能流失，需加量{'\n'}• 上升过快（+10+/周）= 过度积累，易受伤</>}
                    />
                    <MetricCard
                      label="急性负荷" sublabel="ATI (Acute Load)"
                      value={pmcSummary.current_ati != null ? `${pmcSummary.current_ati}` : '—'} unit=""
                      color="#0097a7" detail="7天急性负荷"
                      help={<><strong>急性训练负荷</strong>（7天加权平均），代表近期训练应激。{'\n\n'}使用方法：{'\n'}• ATI 高于 CTI → 负荷累积期{'\n'}• ATI 低于 CTI → 恢复/减量期{'\n'}• 健康训练应呈波浪穿越 CTI{'\n'}• 单日突增 = 比赛或高质量课</>}
                    />
                    <MetricCard
                      label="竞技状态" sublabel="TSB (Form)"
                      value={pmcSummary.current_tsb != null ? `${pmcSummary.current_tsb > 0 ? '+' : ''}${pmcSummary.current_tsb}` : '—'} unit=""
                      color={tsbColor(pmcSummary.current_tsb)}
                      detail={tsbZoneLabel(pmcSummary.current_tsb_zone)}
                      help={<><strong>训练应激平衡 = CTI − ATI</strong>。衡量已从近期训练中恢复多少、是否适合比赛。{'\n\n'}使用方法：{'\n'}• +10~+25 比赛就绪甜区{'\n'}• -10~+10 过渡区{'\n'}• -30~-10 正常训练刺激{'\n'}• 低于 -30 过度负荷，必减量{'\n'}• 高于 +25 减量过多，流失体能</>}
                    />
                    <MetricCard
                      label="状态区间" sublabel="TSB Zone"
                      value={pmcSummary.current_tsb_zone_label || '—'} unit=""
                      color={tsbZoneColor(pmcSummary.current_tsb_zone)}
                      detail={`疲劳 ${pmcSummary.current_fatigue ?? '—'}`}
                      help={<><strong>TSB 的分类标签</strong>，综合给出今日训练决策参考。{'\n\n'}使用方法：{'\n'}• 比赛就绪 → 可上高质量或比赛{'\n'}• 过渡区 → 维持或轻松日{'\n'}• 正常训练 → 有效刺激期{'\n'}• 过度负荷 → 红灯，必须减量{'\n'}• 减量过多 → 该加量了</>}
                    />
                    <MetricCard
                      label="CTL周增量" sublabel="Ramp Rate"
                      value={pmcSummary.ctl_ramp != null ? `${pmcSummary.ctl_ramp > 0 ? '+' : ''}${pmcSummary.ctl_ramp}` : '—'} unit="/周"
                      color={pmcSummary.ctl_ramp != null && Math.abs(pmcSummary.ctl_ramp) > 8 ? '#d32f2f' : '#00a85a'}
                      detail={pmcSummary.ctl_ramp != null && Math.abs(pmcSummary.ctl_ramp) > 8 ? '增量过快' : '安全范围 (±8)'}
                      help={<><strong>CTI 过去7天的变化率</strong>，反映体能增长或衰减速度。{'\n\n'}使用方法：{'\n'}• +3~+7/周 健康递进{'\n'}• 高于 +8/周 增长过快，易受伤{'\n'}• 0 附近 维持期{'\n'}• 低于 -8/周 流失过快，需加量{'\n'}• 赛后 -10~-15 属正常</>}
                    />
                  </div>

                  <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 mb-4">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary">PMC 表现管理图</h3>
                        <p className="text-xs font-mono text-text-muted">Performance Management Chart — CTI / ATI / TSB</p>
                      </div>
                      <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg">
                        {[30, 60, 90].map((d) => (
                          <button
                            key={d}
                            onClick={() => setPmcDays(d)}
                            className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-all ${
                              pmcDays === d ? 'bg-accent-cyan/15 text-accent-cyan' : 'text-text-muted hover:text-text-secondary'
                            }`}
                          >
                            {d}天
                          </button>
                        ))}
                      </div>
                    </div>

                    <ResponsiveContainer width="100%" height={220}>
                      <ComposedChart data={pmcChartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                        <defs>
                          <linearGradient id="gradCTI" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#00a85a" stopOpacity={0.2} />
                            <stop offset="95%" stopColor="#00a85a" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid {...GRID_STYLE} />
                        <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                        <YAxis domain={['dataMin - 15', 'dataMax + 15']} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                        <Tooltip {...TOOLTIP_STYLE} />
                        <Area type="monotone" dataKey="cti" name="CTI (体能)" stroke="#00a85a" strokeWidth={2} fill="url(#gradCTI)" dot={false} activeDot={{ r: 3, fill: '#00a85a', stroke: '#fff', strokeWidth: 2 }} />
                        <Line type="monotone" dataKey="ati" name="ATI (急性负荷)" stroke="#0097a7" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={{ r: 3, fill: '#0097a7', stroke: '#fff', strokeWidth: 2 }} />
                      </ComposedChart>
                    </ResponsiveContainer>

                    <div className="mt-4">
                      <p className="text-xs font-mono text-text-muted mb-2 ml-1">TSB 竞技状态 (CTI − ATI)</p>
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={pmcChartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                          <CartesianGrid {...GRID_STYLE} />
                          <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#d8dae5' }} tickLine={false} />
                          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => {
                            const n = Number(v)
                            const zone = n > 25 ? '减量过多' : n >= 10 ? '比赛就绪' : n >= -10 ? '过渡区' : n >= -30 ? '正常训练' : '过度负荷'
                            return [`${n > 0 ? '+' : ''}${n} (${zone})`, 'TSB']
                          }} />
                          <ReferenceLine y={0} stroke="#8888a0" strokeWidth={1} />
                          <Bar dataKey="tsb" name="TSB">
                            {pmcChartData.map((entry, idx) => {
                              const v = entry.tsb ?? 0
                              const color = v > 25 ? '#e68a00' : v >= 10 ? '#00a85a' : v >= -10 ? '#8888a0' : v >= -30 ? '#0097a7' : '#d32f2f'
                              return <Cell key={idx} fill={color} fillOpacity={0.8} />
                            })}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-3 ml-1">
                      {[
                        { label: '比赛就绪 (10~25)', color: '#00a85a' },
                        { label: '过渡区 (-10~10)', color: '#8888a0' },
                        { label: '正常训练 (-30~-10)', color: '#0097a7' },
                        { label: '过度负荷 (<-30)', color: '#d32f2f' },
                        { label: '减量过多 (>25)', color: '#e68a00' },
                      ].map(({ label, color }) => (
                        <span key={label} className="flex items-center gap-1.5 text-xs font-mono text-text-secondary">
                          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: color }} />
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Data Table */}
              <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in">
                <h3 className="text-sm font-semibold text-text-primary mb-4">
                  近期数据
                  <span className="text-text-muted font-normal ml-2">Recent Records</span>
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead>
                      <tr className="border-b-2 border-border">
                        <th className="text-left py-2 px-3 text-text-primary font-semibold">日期</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">RHR</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">疲劳</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">ATI</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">CTI</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">负荷比</th>
                        <th className="text-right py-2 px-3 text-text-primary font-semibold">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r, i) => (
                        <tr
                          key={r.date}
                          className="border-b border-border-subtle hover:bg-bg-card-hover transition-colors animate-fade-in opacity-0"
                          style={{ animationDelay: `${i * 25}ms`, animationFillMode: 'forwards' }}
                        >
                          <td className="py-2 px-3 text-text-secondary">{formatDate(r.date)}</td>
                          <td className="py-2 px-3 text-right">
                            <span style={{ color: r.rhr != null && r.rhr > 55 ? '#d32f2f' : r.rhr != null && r.rhr > 50 ? '#e68a00' : '#00a85a' }}>
                              {r.rhr ?? '—'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <span style={{ color: fatigueColor(r.fatigue) }}>{r.fatigue ?? '—'}</span>
                          </td>
                          <td className="py-2 px-3 text-right text-accent-cyan">{r.ati ?? '—'}</td>
                          <td className="py-2 px-3 text-right text-accent-green">{r.cti ?? '—'}</td>
                          <td className="py-2 px-3 text-right">
                            <span style={{ color: ratioColor(r.training_load_ratio) }}>
                              {r.training_load_ratio?.toFixed(2) ?? '—'}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-right">
                            <span
                              className="px-2 py-0.5 rounded text-xs"
                              style={{
                                color: loadStateColor(r.training_load_state),
                                backgroundColor: loadStateColor(r.training_load_state) + '15',
                              }}
                            >
                              {loadStateLabel(r.training_load_state)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
  )
}

function MetricCards({ latest, hrv, rhrBaseline }: { latest: HealthRecord; hrv: HRVSnapshot | null; rhrBaseline: number | null }) {
  const hrvValue = hrv?.avg_sleep_hrv
  const hrvLow = hrv?.hrv_normal_low
  const hrvHigh = hrv?.hrv_normal_high
  const hrvColor = hrvValue != null && hrvLow != null && hrvHigh != null
    ? (hrvValue >= hrvLow && hrvValue <= hrvHigh ? '#00a85a' : hrvValue > hrvHigh ? '#0097a7' : '#e68a00')
    : '#8888a0'

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      <MetricCard
        label="静息心率"
        sublabel="RHR"
        value={latest.rhr != null ? `${latest.rhr}` : '—'}
        unit="bpm"
        color={
          latest.rhr == null || rhrBaseline == null ? '#8888a0'
            : latest.rhr > rhrBaseline + 8 ? '#d32f2f'
            : latest.rhr > rhrBaseline + 3 ? '#ffab00'
            : '#00a85a'
        }
        detail={rhrBaseline != null ? `基线 ${rhrBaseline} bpm` : '基线 —'}
        help={<><strong>清晨静息心率</strong>。反映心血管恢复与自主神经平衡。{'\n\n'}使用方法：{'\n'}{rhrBaseline != null ? `• 接近基线（${rhrBaseline}）= 恢复良好\n` : '• 基线按过去 90 天的 RHR 低 10 分位动态计算\n'}• 高出基线 3+ bpm 持续 3 天 = 疲劳累积{'\n'}• 高出 8+ = 生病/过劳，立即休息{'\n'}• 训练越久通常越低</>}
      />
      <MetricCard
        label="睡眠HRV"
        sublabel="Heart Rate Variability"
        value={hrvValue != null ? `${hrvValue}` : '—'}
        unit="ms"
        color={hrvColor}
        detail={hrvLow != null && hrvHigh != null ? `正常范围 ${hrvLow}-${hrvHigh}` : ''}
        help={<><strong>睡眠心率变异性</strong>。反映副交感神经恢复程度。{'\n\n'}使用方法：{'\n'}• 在正常范围内稳定 = 恢复充分{'\n'}• 下降 10% = 黄灯，注意{'\n'}• 下降 20%+ = 红灯，跳过高质量{'\n'}• 高于上限 = 深度恢复/副交感活跃</>}
      />
      <MetricCard
        label="疲劳指数"
        sublabel="Fatigue"
        value={latest.fatigue != null ? `${latest.fatigue}` : '—'}
        unit=""
        color={fatigueColor(latest.fatigue)}
        detail={latest.fatigue != null ? (latest.fatigue < 40 ? '已恢复' : latest.fatigue < 50 ? '正常' : latest.fatigue < 60 ? '疲劳' : '高疲劳') : ''}
        help={<><strong>疲劳评分</strong>（0-100），综合训练与恢复数据。{'\n\n'}使用方法：{'\n'}• 低于 40 已恢复，可上质量课{'\n'}• 40-50 正常训练{'\n'}• 50-60 疲劳中，减强度{'\n'}• 高于 60 高疲劳，跳过训练或休息</>}
      />
      <MetricCard
        label="训练负荷比"
        sublabel="ATI / CTI"
        value={latest.training_load_ratio?.toFixed(2) ?? '—'}
        unit={latest.ati != null && latest.cti != null ? `${latest.ati} / ${latest.cti}` : ''}
        color={ratioColor(latest.training_load_ratio)}
        detail={latest.training_load_ratio != null ? (
          latest.training_load_ratio < 0.7 ? '偏低' :
          latest.training_load_ratio <= 1.0 ? '最佳' :
          latest.training_load_ratio <= 1.2 ? '偏高' : '过高'
        ) : ''}
        help={<><strong>急性 / 慢性负荷比</strong>。反映近期应激相对于基线。{'\n\n'}使用方法：{'\n'}• 0.8-1.1 健康训练区{'\n'}• 高于 1.2 过度应激，减量{'\n'}• 高于 1.5 极高风险，强制休息{'\n'}• 低于 0.7 流失体能，需加量{'\n'}• 4周块均值 ≈ 1.0 为理想周期化</>}
      />
      <MetricCard
        label="负荷状态"
        sublabel="Load State"
        value={loadStateLabel(latest.training_load_state)}
        unit=""
        color={loadStateColor(latest.training_load_state)}
        detail={formatDate(latest.date)}
        help={<><strong>负荷分类标签</strong>（Low / Optimal / High / Very High），由手表按近期训练应激综合打分。{'\n\n'}使用方法：{'\n'}• Optimal 持续期 = 最佳建构区{'\n'}• High 是递增周常态{'\n'}• Very High 持续超 2 周 = 过度训练{'\n'}• Low = 减量、赛后或伤停</>}
      />
    </div>
  )
}

function MetricCard({ label, sublabel, value, unit, color, detail, help }: {
  label: string; sublabel: string; value: string; unit: string; color: string; detail: string; help?: React.ReactNode
}) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-xl p-4 hover:bg-bg-card-hover transition-all duration-200 overflow-visible">
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-text-secondary">{label}</p>
          <p className="text-xs font-mono text-text-muted">{sublabel}</p>
        </div>
        <div className="flex items-center gap-2">
          {help && (
            <div className="group relative">
              <div className="w-4 h-4 rounded-full border border-border-subtle text-[10px] font-mono text-text-muted cursor-help flex items-center justify-center hover:border-text-secondary hover:text-text-secondary transition-colors">?</div>
              <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity absolute right-0 top-6 z-50 w-64 bg-bg-card border border-border-subtle rounded-lg p-3 shadow-lg text-xs text-text-primary font-normal leading-relaxed whitespace-pre-line pointer-events-none">
                {help}
              </div>
            </div>
          )}
          <div className="w-2 h-2 rounded-full shrink-0 mt-1" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}40` }} />
        </div>
      </div>
      <p className="text-2xl font-bold font-mono tracking-tight" style={{ color }}>
        {value}
        {unit && <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>}
      </p>
      {detail && <p className="text-xs font-mono text-text-muted mt-1">{detail}</p>}
    </div>
  )
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-xs font-mono text-text-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}
