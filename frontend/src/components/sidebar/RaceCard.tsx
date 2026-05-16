import { useEffect, useState } from 'react'
import { getMyProfile, type MyProfile } from '../../api'
import { shanghaiToday } from '../../lib/shanghai'

const DIST_LABEL: Record<string, string> = { FM: '全马', HM: '半马', '10K': '10K', '5K': '5K' }

interface RaceCardProps {
  collapsed?: boolean
}

export default function RaceCard({ collapsed }: RaceCardProps) {
  const [profile, setProfile] = useState<MyProfile | null>(null)

  useEffect(() => {
    let cancelled = false
    getMyProfile()
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (collapsed) return null
  const p = profile?.profile as
    | { target_race?: string; target_race_date?: string; target_distance?: string }
    | null
    | undefined
  if (!p?.target_race || !p?.target_race_date) return null

  const dDay = daysUntil(p.target_race_date)
  const dist = p.target_distance ? DIST_LABEL[p.target_distance] ?? p.target_distance : ''
  const md = p.target_race_date.slice(5)

  return (
    <div className="rounded-xl px-3 py-2.5 border border-accent-green/30 bg-gradient-to-br from-accent-green/10 to-accent-cyan/10">
      <p className="font-mono text-[9px] text-accent-green-dim tracking-wider font-semibold uppercase">
        目标赛事
      </p>
      <p className="text-[12px] font-semibold leading-tight mt-0.5 text-text-primary truncate">
        {p.target_race}
      </p>
      <div className="font-mono text-[10px] text-text-muted mt-1 flex justify-between">
        <span>
          {md}
          {dist && ` · ${dist}`}
        </span>
        <span className="text-accent-green-dim font-semibold">D-{dDay}</span>
      </div>
    </div>
  )
}

function daysUntil(targetIso: string): number {
  const today = shanghaiToday()
  const [y1, m1, d1] = today.split('-').map(Number)
  const [y2, m2, d2] = targetIso.split('-').map(Number)
  const t0 = Date.UTC(y1, m1 - 1, d1)
  const t1 = Date.UTC(y2, m2 - 1, d2)
  return Math.round((t1 - t0) / 86_400_000)
}
