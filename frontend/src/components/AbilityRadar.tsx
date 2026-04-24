import { useState } from 'react'
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

interface DimExplain {
  formula: string
  anchor: string
  source: string
}

const DIM_EXPLAIN: Record<string, DimExplain> = {
  aerobic: {
    formula: '365 天内 HR 145±7 bpm 区间下最快的持续 ≥5km 跑配速（max_hr > 170 的混合强度跑被排除）',
    anchor: '5:00/km @ HR 145 = 80 分（每快 1 s/km +0.3 分）',
    source: '反映长期有氧效率：相同心率下能跑多快',
  },
  lt: {
    formula: '365 天内最快的连续 30 分钟 tempo 配速（rest lap 中断累积，避免间歇课误判）',
    anchor: '4:10/km 持续 30min = 80 分（每快 1 s/km +0.5 分）',
    source: 'Tinman vLT — 反映 1 小时赛速能力',
  },
  vo2max: {
    formula: '三路径估算取最高：Daniels VDOT（间歇/5K 公式反算）、HR-pace 回归（E 跑外推到 HRmax）、Uth-Sørensen（15.3 × HRmax/RHR）。全马成绩用 Daniels 表逆查（公式对 3h+ 低估）',
    anchor: 'VDOT 62 ≈ 全马 3:00 = 60 分（每多 1 VDOT +2 分）',
    source: '三家差异 > 5 ml/kg/min 时面板会标 ⚠ 提示',
  },
  endurance: {
    formula: '365 天最长跑距离 + HR drift 修正（drift 越低权重越高）',
    anchor: '42km 全马 = 80 分（drift 影响系数 0.5）',
    source: '反映马拉松专项耐力 + 长距离配速一致性',
  },
  economy: {
    formula: '4:50/km ±10s 配速段中位步频',
    anchor: '180 spm = 80 分（每多/少 1 spm 调整）',
    source: '反映跑姿效率 — 步频高通常单位距离能耗低',
  },
  recovery: {
    formula: '过去 7 天 L2 freshness 平均（包含 TSB、RHR 偏离基线、HRV、COROS fatigue 综合）',
    anchor: '不同于其他 5 维，是"当下状态"而非"长期能力"',
    source: '会随训练负荷快速变化',
  },
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

  const [showHelp, setShowHelp] = useState(false)

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">六维实力雷达</h3>
            <p className="text-xs font-mono text-text-muted">L3 Ability Dimensions · 0-100</p>
          </div>
          <button
            onClick={() => setShowHelp((v) => !v)}
            className={`w-5 h-5 rounded-full border text-[11px] font-bold leading-none transition-all ${
              showHelp
                ? 'border-accent-green text-accent-green bg-accent-green/10'
                : 'border-text-muted/40 text-text-muted hover:border-accent-green hover:text-accent-green'
            }`}
            title={showHelp ? '收起说明' : '查看六维定义'}
            aria-label="dimensions help"
          >
            ?
          </button>
        </div>
        {composite != null && (
          <div className="text-right">
            <p className="text-xs font-mono text-text-muted">综合 L4</p>
            <p className="text-2xl font-bold font-mono text-accent-green tracking-tight">
              {fmtScore(composite, 2)}
            </p>
          </div>
        )}
      </div>

      {showHelp && (
        <div className="mb-4 p-4 bg-bg-secondary rounded-xl border border-border-subtle space-y-3 animate-fade-in">
          {(Object.keys(DIM_LABELS) as (keyof typeof DIM_LABELS)[]).map((k) => {
            const ex = DIM_EXPLAIN[k]
            return (
              <div key={k} className="text-xs">
                <p className="font-semibold text-text-primary">
                  {DIM_LABELS[k]}
                  <span className="ml-2 font-mono text-[10px] text-text-muted">{DIM_SUBS[k]}</span>
                </p>
                <p className="text-text-secondary font-mono mt-0.5 leading-relaxed">{ex.formula}</p>
                <p className="text-text-muted font-mono mt-0.5">⚓ {ex.anchor}</p>
                <p className="text-text-muted font-mono italic">↳ {ex.source}</p>
              </div>
            )
          })}
          <p className="text-[10px] font-mono text-text-muted pt-2 border-t border-border-subtle">
            数据窗口 365 天 · best-performance 语义 · 锚点详见 src/stride_core/ability.py 顶部常量
          </p>
        </div>
      )}

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
            name="实力"
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
            formatter={(v: unknown) => [fmtScore(Number(v), 2), '分数']}
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
              {fmtScore(d.rawScore, 2)}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}
