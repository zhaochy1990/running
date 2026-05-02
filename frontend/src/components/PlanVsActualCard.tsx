import type { Activity } from '../api'
import type { PlannedSession } from '../types/plan'

export type Adherence = 'green' | 'amber' | 'red'

export interface AdherenceJudgement {
  adherence: Adherence
  /** Signed delta (actual - target). Null when target unknown. */
  delta: number | null
  /** % delta from midpoint of target range. Null when target unknown. */
  pctDelta: number | null
}

/**
 * Adherence color rules:
 *   green  — within 5% of target midpoint (or within explicit target band when given a low/high range).
 *   amber  — within 15% of target midpoint.
 *   red    — outside 15%, or one side known but the other unknown when divergence is provable.
 *
 * Returns `green` for null actual + null target (no information either way).
 */
export function judgeNumeric(
  actual: number | null,
  targetLow: number | null,
  targetHigh: number | null,
  /** When true, smaller-is-better (e.g. pace seconds-per-km). */
  invert = false,
): AdherenceJudgement {
  if (actual == null || (targetLow == null && targetHigh == null)) {
    return { adherence: 'green', delta: null, pctDelta: null }
  }
  const low = targetLow ?? targetHigh!
  const high = targetHigh ?? targetLow!
  const lo = Math.min(low, high)
  const hi = Math.max(low, high)
  const mid = (lo + hi) / 2
  const delta = actual - mid
  const pct = mid === 0 ? 0 : (delta / mid) * 100

  // Inside band → green.
  if (actual >= lo && actual <= hi) {
    return { adherence: 'green', delta, pctDelta: pct }
  }

  // Outside band — judge severity. For pace (invert=true) being faster than
  // the band still counts as adherence-friendly up to 5%, but slower than the
  // band is the bad direction. For HR / distance, larger absolute pct is worse
  // regardless of side.
  const absPct = Math.abs(pct)
  let adherence: Adherence
  if (invert) {
    // smaller is better. delta < 0 means faster than midpoint.
    if (delta < 0) {
      adherence = absPct <= 5 ? 'green' : absPct <= 15 ? 'amber' : 'red'
    } else {
      adherence = absPct <= 5 ? 'green' : absPct <= 15 ? 'amber' : 'red'
    }
  } else {
    adherence = absPct <= 5 ? 'green' : absPct <= 15 ? 'amber' : 'red'
  }
  return { adherence, delta, pctDelta: pct }
}

const ADHERENCE_COLOR: Record<Adherence, string> = {
  green: '#00a85a',
  amber: '#e68a00',
  red: '#d32f2f',
}

const ADHERENCE_BG: Record<Adherence, string> = {
  green: '#00a85a15',
  amber: '#e68a0015',
  red: '#d32f2f15',
}

function fmtKm(m: number | null): string {
  if (m == null) return '—'
  return `${(m / 1000).toFixed(2)} km`
}

function fmtPaceSecKm(s: number | null): string {
  if (s == null) return '—'
  const t = Math.round(s)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}/km`
}

function planPaceRange(session: PlannedSession): { low: number | null; high: number | null } {
  if (!session.spec || session.spec.schema !== 'run-workout/v1') {
    return { low: null, high: null }
  }
  for (const block of session.spec.blocks) {
    for (const step of block.steps) {
      if (step.target.kind === 'pace_s_km' && step.target.low != null && step.target.high != null) {
        return { low: step.target.low, high: step.target.high }
      }
    }
  }
  return { low: null, high: null }
}

function planHRRange(session: PlannedSession): { low: number | null; high: number | null } {
  if (!session.spec || session.spec.schema !== 'run-workout/v1') {
    return { low: null, high: null }
  }
  for (const block of session.spec.blocks) {
    for (const step of block.steps) {
      if (step.target.kind === 'hr_bpm' && step.target.low != null && step.target.high != null) {
        return { low: step.target.low, high: step.target.high }
      }
    }
  }
  return { low: null, high: null }
}

export interface PlanVsActualCardProps {
  session: PlannedSession
  activity: Activity
}

export default function PlanVsActualCard({ session, activity }: PlanVsActualCardProps) {
  const planDistanceM = session.total_distance_m
  const actualDistanceM = activity.distance_m

  const planPace = planPaceRange(session)
  const planHR = planHRRange(session)

  const distJudge = judgeNumeric(
    actualDistanceM,
    planDistanceM != null ? planDistanceM * 0.95 : null,
    planDistanceM != null ? planDistanceM * 1.05 : null,
  )
  const paceJudge = judgeNumeric(activity.avg_pace_s_km, planPace.low, planPace.high, true)
  const hrJudge = judgeNumeric(activity.avg_hr, planHR.low, planHR.high)

  return (
    <div
      data-testid="plan-vs-actual-card"
      className="bg-bg-card border border-border-subtle rounded-2xl p-5 mb-6"
    >
      <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">
        训练计划对照
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Row
          label="距离"
          plan={fmtKm(planDistanceM)}
          actual={fmtKm(actualDistanceM)}
          judgement={distJudge}
        />
        <Row
          label="平均配速"
          plan={
            planPace.low != null && planPace.high != null
              ? `${fmtPaceSecKm(planPace.high)} – ${fmtPaceSecKm(planPace.low)}`
              : '—'
          }
          actual={fmtPaceSecKm(activity.avg_pace_s_km)}
          judgement={paceJudge}
        />
        <Row
          label="平均心率"
          plan={
            planHR.low != null && planHR.high != null
              ? `${Math.round(planHR.low)}–${Math.round(planHR.high)} bpm`
              : '—'
          }
          actual={activity.avg_hr != null ? `${activity.avg_hr} bpm` : '—'}
          judgement={hrJudge}
        />
      </div>
    </div>
  )
}

function Row({
  label,
  plan,
  actual,
  judgement,
}: {
  label: string
  plan: string
  actual: string
  judgement: AdherenceJudgement
}) {
  const cls = `adherence-${judgement.adherence}`
  return (
    <div className="rounded-lg border border-border-subtle p-3">
      <p className="text-xs font-mono text-text-muted uppercase tracking-wider mb-1">{label}</p>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono text-text-muted">计划</p>
          <p className="text-sm font-mono text-text-secondary">{plan}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-mono text-text-muted">实际</p>
          <p
            className={`text-sm font-mono font-semibold ${cls}`}
            data-testid={`adherence-${label}`}
            style={{
              color: ADHERENCE_COLOR[judgement.adherence],
              backgroundColor: ADHERENCE_BG[judgement.adherence],
              padding: '0 6px',
              borderRadius: 4,
            }}
          >
            <span className={cls}>{actual}</span>
          </p>
        </div>
      </div>
    </div>
  )
}
