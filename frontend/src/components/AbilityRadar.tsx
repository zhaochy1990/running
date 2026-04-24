import {
  Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip,
} from 'recharts'
import type { AbilityCurrent } from '../api'
import { fmtScore } from '../lib/fmt'

const DIM_LABELS: Record<string, string> = {
  aerobic: '有氧',
  lt: '乳酸阈',
  vo2max: '最大摄氧',
  endurance: '耐力',
  economy: '经济性',
  recovery: '恢复',
}

const DIM_SUBS: Record<string, string> = {
  aerobic: 'Aerobic',
  lt: 'LT',
  vo2max: 'VO2max',
  endurance: 'Endurance',
  economy: 'Economy',
  recovery: 'Recovery',
}

export default function AbilityRadar({
  current, weights,
}: { current: AbilityCurrent; weights: Record<string, number> | null }) {
  const dims = current.l3_dimensions
  const composite = current.l4_composite

  const data = (Object.keys(DIM_LABELS) as (keyof typeof DIM_LABELS)[]).map((k) => {
    const score = dims[k as keyof typeof dims]?.score ?? 0
    const w = weights?.[k]
    return {
      dimension: DIM_LABELS[k],
      key: k,
      weight: w,
      score: Math.max(0, Math.min(100, score ?? 0)),
      rawScore: score,
    }
  })

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">六维能力雷达</h3>
          <p className="text-xs font-mono text-text-muted">L3 Ability Dimensions · 0-100</p>
        </div>
        {composite != null && (
          <div className="text-right">
            <p className="text-xs font-mono text-text-muted">综合 L4</p>
            <p className="text-2xl font-bold font-mono text-accent-green tracking-tight">
              {fmtScore(composite, 1)}
            </p>
          </div>
        )}
      </div>

      <ResponsiveContainer width="100%" height={320}>
        <RadarChart data={data} outerRadius="75%">
          <PolarGrid stroke="#e8eaf0" />
          <PolarAngleAxis
            dataKey="dimension"
            tick={{ fontSize: 11, fontFamily: 'JetBrains Mono', fill: '#4a4c60' }}
          />
          <PolarRadiusAxis
            domain={[0, 100]}
            tickCount={6}
            tick={{ fontSize: 9, fontFamily: 'JetBrains Mono', fill: '#8888a0' }}
            axisLine={false}
          />
          <Radar
            name="能力"
            dataKey="score"
            stroke="#00a85a"
            fill="#00a85a"
            fillOpacity={0.25}
            strokeWidth={2}
            dot={{ fill: '#00a85a', r: 3 }}
          />
          <Tooltip
            contentStyle={{
              background: '#ffffff', border: '1px solid #d8dae5', borderRadius: 8,
              fontFamily: 'JetBrains Mono', fontSize: 12, color: '#1a1c2e',
            }}
            formatter={(v: unknown) => [fmtScore(Number(v), 1), '分数']}
          />
        </RadarChart>
      </ResponsiveContainer>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-4">
        {data.map((d) => (
          <div
            key={d.key}
            className="flex items-baseline justify-between px-3 py-2 bg-bg-secondary rounded-lg"
          >
            <div>
              <p className="text-xs font-medium text-text-secondary">{d.dimension}</p>
              <p className="text-[10px] font-mono text-text-muted">
                {DIM_SUBS[d.key]}
                {d.weight != null && ` · w=${d.weight}`}
              </p>
            </div>
            <p className="text-lg font-bold font-mono text-accent-green tracking-tight">
              {fmtScore(d.rawScore, 1)}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
