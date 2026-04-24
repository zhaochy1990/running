import type { L3Dimension } from '../api'
import { fmtScore } from '../lib/fmt'

function pickNum(x: unknown): number | null {
  return typeof x === 'number' && isFinite(x) ? x : null
}

function pickStr(x: unknown): string | null {
  return typeof x === 'string' ? x : null
}

const SOURCE_LABELS: Record<string, string> = {
  primary: '主路径',
  secondary: '备选路径',
  floor: '基线估算',
  none: '无数据',
}

const SOURCE_COLORS: Record<string, string> = {
  primary: '#00a85a',
  secondary: '#0097a7',
  floor: '#8888a0',
  none: '#8888a0',
}

export default function Vo2maxPanel({
  vo2max,
  dataSource,
  onRefresh,
  refreshing,
}: {
  vo2max: L3Dimension
  dataSource?: 'snapshot' | 'computed'
  onRefresh?: () => void
  refreshing?: boolean
}) {
  const primary = pickNum(vo2max.vo2max_primary)
  const secondary = pickNum(vo2max.vo2max_secondary)
  const floor = pickNum(vo2max.vo2max_floor)
  const used = pickNum(vo2max.vo2max_used)
  const usedVdot = pickNum(vo2max.vo2max_used_vdot)
  const source = pickStr(vo2max.vo2max_source) || 'none'

  const hasBreakdown = primary != null || secondary != null || floor != null
  const hint = !hasBreakdown
    ? '今日从快照读取；刷新后将显示三路径对比'
    : '主路径 = 近期最佳表现；备选 = HR-pace 回归；基线 = UTH/Sörensen'

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">最大摄氧 (VO2max)</h3>
          <p className="text-xs font-mono text-text-muted">
            三路径对比 · 当前源: {' '}
            <span style={{ color: SOURCE_COLORS[source] }}>{SOURCE_LABELS[source]}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-mono text-text-muted">VO2max</p>
          <p className="text-2xl font-bold font-mono text-accent-green tracking-tight">
            {used != null ? fmtScore(used, 1) : '—'}
            <span className="text-xs font-normal text-text-muted ml-1">ml/kg/min</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <Path
          label="主路径"
          sublabel="Primary · best performance"
          value={primary}
          unit="ml/kg/min"
          active={source === 'primary'}
          color="#00a85a"
        />
        <Path
          label="备选路径"
          sublabel="Secondary · HR-pace"
          value={secondary}
          unit="ml/kg/min"
          active={source === 'secondary'}
          color="#0097a7"
        />
        <Path
          label="基线估算"
          sublabel="Floor · UTH/Sörensen"
          value={floor}
          unit="ml/kg/min"
          active={source === 'floor'}
          color="#8888a0"
        />
      </div>

      <div className="flex items-center justify-between bg-bg-secondary rounded-lg px-4 py-3">
        <div>
          <p className="text-xs font-mono text-text-muted">采用值 Used</p>
          <p className="text-lg font-bold font-mono text-text-primary tracking-tight">
            {used != null ? `${fmtScore(used, 1)} ml/kg/min` : '—'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-mono text-text-muted">等效 VDOT</p>
          <p className="text-lg font-bold font-mono text-text-primary tracking-tight">
            {fmtScore(usedVdot, 1)}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] font-mono text-text-muted leading-relaxed">{hint}</p>
        {dataSource === 'snapshot' && onRefresh && (
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="text-[11px] font-mono px-2 py-1 rounded border border-accent-green/30 text-accent-green hover:bg-accent-green/10 disabled:opacity-50 disabled:cursor-wait whitespace-nowrap"
            title="强制实时计算三路径 (10-60s)"
          >
            {refreshing ? '计算中…' : '🔄 刷新'}
          </button>
        )}
      </div>
    </div>
  )
}

function Path({ label, sublabel, value, unit, active, color }: {
  label: string; sublabel: string; value: number | null; unit: string
  active: boolean; color: string
}) {
  return (
    <div
      className={`rounded-xl p-3 border transition-all ${
        active ? '' : 'opacity-70'
      }`}
      style={{
        borderColor: active ? color + '60' : '#e8eaf0',
        backgroundColor: active ? color + '10' : 'transparent',
      }}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-secondary">{label}</p>
        {active && (
          <span
            className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
            style={{ color, backgroundColor: color + '20' }}
          >
            ACTIVE
          </span>
        )}
      </div>
      <p className="text-[10px] font-mono text-text-muted">{sublabel}</p>
      <p className="text-xl font-bold font-mono tracking-tight mt-1.5" style={{ color }}>
        {value != null ? fmtScore(value, 1) : '—'}
        <span className="text-[10px] font-normal text-text-muted ml-1">{unit}</span>
      </p>
    </div>
  )
}
