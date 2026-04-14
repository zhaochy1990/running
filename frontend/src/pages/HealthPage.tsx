import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts'
import { getHealth, type HealthRecord } from '../api'
import { useUser } from '../UserContext'

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

const AXIS_TICK = { fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#555570' }
const TOOLTIP_STYLE = {
  contentStyle: { background: '#1e1e2e', border: '1px solid #2a2a3e', borderRadius: 8, fontFamily: 'JetBrains Mono', fontSize: 12, color: '#e8e8f0' },
  labelStyle: { color: '#8888a0' },
}
const GRID_STYLE = { stroke: '#1e1e30', strokeDasharray: '3 3' }

function fatigueColor(v: number | null): string {
  if (v == null) return '#555570'
  if (v < 40) return '#00e676'
  if (v < 50) return '#00e5ff'
  if (v < 60) return '#ffab00'
  return '#ff5252'
}

function ratioColor(v: number | null): string {
  if (v == null) return '#555570'
  if (v < 0.7) return '#00e5ff'
  if (v <= 1.0) return '#00e676'
  if (v <= 1.2) return '#ffab00'
  return '#ff5252'
}

function loadStateLabel(state: string | null): string {
  const map: Record<string, string> = { Low: '低', Optimal: '最佳', High: '偏高', 'Very High': '很高' }
  return state ? (map[state] || state) : '—'
}

function loadStateColor(state: string | null): string {
  const map: Record<string, string> = { Low: '#00e5ff', Optimal: '#00e676', High: '#ffab00', 'Very High': '#ff5252' }
  return state ? (map[state] || '#555570') : '#555570'
}

export default function HealthPage() {
  const navigate = useNavigate()
  const { user, setUser, users } = useUser()
  const [records, setRecords] = useState<HealthRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(30)

  useEffect(() => {
    if (!user) return
    setLoading(true)
    getHealth(user, days)
      .then((data) => setRecords(data.health))
      .finally(() => setLoading(false))
  }, [days, user])

  // Records come newest first; reverse for charts
  const chartData = [...records].reverse().map((r) => ({
    ...r,
    dateLabel: formatDate(r.date),
  }))

  const latest = records[0] // newest

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <nav className="w-[260px] min-h-screen bg-bg-secondary border-r border-border flex flex-col fixed left-0 top-0 z-40">
        <div className="px-5 pt-6 pb-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-accent-green/15 flex items-center justify-center">
                <span className="text-accent-green text-sm font-bold font-mono">S</span>
              </div>
              <div>
                <h1 className="text-base font-bold tracking-tight text-text-primary leading-none">STRIDE</h1>
                <p className="text-[10px] font-mono text-text-muted tracking-widest mt-0.5">训练中心</p>
              </div>
            </div>
            {users.length > 1 && <UserDropdown user={user} users={users} onSelect={(u) => { setUser(u); navigate('/') }} />}
          </div>
        </div>

        <div className="px-3 flex-1 flex flex-col gap-1.5">
          <button
            onClick={() => navigate('/')}
            className="w-full text-left px-4 py-3 rounded-xl border border-border-subtle bg-bg-card hover:bg-bg-card-hover hover:border-border transition-all duration-200 text-sm font-medium text-text-secondary"
          >
            训练周
          </button>
          <button
            className="w-full text-left px-4 py-3 rounded-xl border border-accent-cyan/30 bg-accent-cyan/8 transition-all duration-200 text-sm font-medium text-accent-cyan"
          >
            身体指标
          </button>
        </div>

        <div className="px-3 py-3 border-t border-border-subtle">
          <p className="text-[10px] font-mono text-text-muted text-center">COROS PACE 4</p>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 ml-[260px]">
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
              {latest && <MetricCards latest={latest} />}

              {/* Charts 2x2 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <ChartCard title="静息心率" subtitle="Resting Heart Rate">
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        <linearGradient id="gradRHR" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#00e676" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#00e676" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#2a2a3e' }} tickLine={false} />
                      <YAxis domain={['dataMin - 3', 'dataMax + 3']} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v} bpm`, 'RHR']} />
                      <ReferenceLine y={47} stroke="#00e676" strokeDasharray="4 4" strokeOpacity={0.5} />
                      <ReferenceLine y={50} stroke="#ffab00" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <ReferenceLine y={55} stroke="#ff5252" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <Area type="monotone" dataKey="rhr" stroke="#00e676" strokeWidth={1.5} fill="url(#gradRHR)" dot={false} activeDot={{ r: 3, fill: '#00e676', stroke: '#1e1e2e', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="疲劳趋势" subtitle="Fatigue Index">
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <defs>
                        <linearGradient id="gradFatigue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ffab00" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#ffab00" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#2a2a3e' }} tickLine={false} />
                      <YAxis domain={[20, 70]} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [`${v}`, '疲劳值']} />
                      <ReferenceLine y={40} stroke="#00e676" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: '恢复', position: 'right', fill: '#00e676', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                      <ReferenceLine y={50} stroke="#ffab00" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: '疲劳', position: 'right', fill: '#ffab00', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                      <ReferenceLine y={60} stroke="#ff5252" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: '高疲劳', position: 'right', fill: '#ff5252', fontSize: 9, fontFamily: 'JetBrains Mono' }} />
                      <Area type="monotone" dataKey="fatigue" stroke="#ffab00" strokeWidth={1.5} fill="url(#gradFatigue)" dot={false} activeDot={{ r: 3, fill: '#ffab00', stroke: '#1e1e2e', strokeWidth: 2 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="ATI vs CTI" subtitle="Acute / Chronic Training Index">
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#2a2a3e' }} tickLine={false} />
                      <YAxis domain={['dataMin - 10', 'dataMax + 10']} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip {...TOOLTIP_STYLE} />
                      <Line type="monotone" dataKey="ati" name="ATI (急性)" stroke="#00e5ff" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: '#00e5ff', stroke: '#1e1e2e', strokeWidth: 2 }} />
                      <Line type="monotone" dataKey="cti" name="CTI (慢性)" stroke="#00e676" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: '#00e676', stroke: '#1e1e2e', strokeWidth: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>

                <ChartCard title="训练负荷比" subtitle="Training Load Ratio (ATI/CTI)">
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -5 }}>
                      <CartesianGrid {...GRID_STYLE} />
                      <XAxis dataKey="dateLabel" tick={AXIS_TICK} axisLine={{ stroke: '#2a2a3e' }} tickLine={false} />
                      <YAxis domain={[0, 'dataMax + 0.3']} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                      <Tooltip {...TOOLTIP_STYLE} formatter={(v: unknown) => [typeof v === 'number' ? v.toFixed(2) : `${v}`, '负荷比']} />
                      <ReferenceLine y={0.8} stroke="#00e676" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <ReferenceLine y={1.0} stroke="#ffab00" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <ReferenceLine y={1.2} stroke="#ff5252" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <Bar dataKey="training_load_ratio" radius={[2, 2, 0, 0]} maxBarSize={12}>
                        {chartData.map((entry, i) => (
                          <Cell key={i} fill={ratioColor(entry.training_load_ratio)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              </div>

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
                            <span style={{ color: r.rhr != null && r.rhr > 55 ? '#ff5252' : r.rhr != null && r.rhr > 50 ? '#ffab00' : '#e8e8f0' }}>
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
                              className="px-1.5 py-0.5 rounded text-[10px]"
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
      </main>
    </div>
  )
}

function MetricCards({ latest }: { latest: HealthRecord }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <MetricCard
        label="静息心率"
        sublabel="RHR"
        value={latest.rhr != null ? `${latest.rhr}` : '—'}
        unit="bpm"
        color={latest.rhr != null && latest.rhr > 55 ? '#ff5252' : latest.rhr != null && latest.rhr > 50 ? '#ffab00' : '#00e676'}
        detail="基线 47 bpm"
      />
      <MetricCard
        label="疲劳指数"
        sublabel="Fatigue"
        value={latest.fatigue != null ? `${latest.fatigue}` : '—'}
        unit=""
        color={fatigueColor(latest.fatigue)}
        detail={latest.fatigue != null ? (latest.fatigue < 40 ? '已恢复' : latest.fatigue < 50 ? '正常' : latest.fatigue < 60 ? '疲劳' : '高疲劳') : ''}
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
      />
      <MetricCard
        label="负荷状态"
        sublabel="Load State"
        value={loadStateLabel(latest.training_load_state)}
        unit=""
        color={loadStateColor(latest.training_load_state)}
        detail={formatDate(latest.date)}
      />
    </div>
  )
}

function MetricCard({ label, sublabel, value, unit, color, detail }: {
  label: string; sublabel: string; value: string; unit: string; color: string; detail: string
}) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-xl p-4 hover:bg-bg-card-hover transition-all duration-200">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-medium text-text-secondary">{label}</p>
          <p className="text-[10px] font-mono text-text-muted">{sublabel}</p>
        </div>
        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}40` }} />
      </div>
      <p className="text-2xl font-bold font-mono tracking-tight" style={{ color }}>
        {value}
        {unit && <span className="text-xs font-normal text-text-muted ml-1">{unit}</span>}
      </p>
      {detail && <p className="text-[10px] font-mono text-text-muted mt-1">{detail}</p>}
    </div>
  )
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-[10px] font-mono text-text-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

function UserDropdown({ user, users, onSelect }: { user: string; users: string[]; onSelect: (u: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg bg-accent-purple/10 text-accent-purple hover:bg-accent-purple/20 transition-all"
      >
        {user}
        <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 12 12" fill="none">
          <path d="M3 5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-[120px] bg-bg-card border border-border-subtle rounded-lg shadow-lg py-1 z-50 animate-fade-in">
          {users.map((u) => (
            <button
              key={u}
              onClick={() => { onSelect(u); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-[11px] font-medium transition-all ${
                u === user
                  ? 'text-accent-purple bg-accent-purple/10'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-card-hover'
              }`}
            >
              {u}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
