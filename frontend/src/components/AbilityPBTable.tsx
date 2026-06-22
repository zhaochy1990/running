import { Link } from 'react-router-dom'
import type { PBEntry } from '../api'
import { fmtClock, fmtPace } from '../lib/fmt'

// Fixed display order + per-distance metadata. Mirrors DISTANCE_ORDER on the
// backend so every distance always renders a row (— when no record exists).
const PB_ROWS: { code: string; label: string; km: number }[] = [
  { code: '1K', label: '1K', km: 1 },
  { code: '3K', label: '3K', km: 3 },
  { code: '5K', label: '5K', km: 5 },
  { code: '10K', label: '10K', km: 10 },
  { code: 'HM', label: '半马', km: 21.0975 },
  { code: 'FM', label: '全马', km: 42.195 },
]

export default function AbilityPBTable({ pbs }: { pbs: PBEntry[] }) {
  const byCode = new Map(pbs.map((p) => [p.distance, p]))

  return (
    <div>
      <p className="text-xs font-mono text-text-muted tracking-widest mb-3 uppercase">
        个人最佳 · Personal Bests
      </p>
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-border">
                <th className="text-left py-2 px-3 text-xs font-mono text-text-muted tracking-wider">距离</th>
                <th className="text-right py-2 px-3 text-xs font-mono text-text-muted tracking-wider">成绩</th>
                <th className="text-right py-2 px-3 text-xs font-mono text-text-muted tracking-wider">配速</th>
                <th className="text-right py-2 px-3 text-xs font-mono text-text-muted tracking-wider">日期</th>
                <th className="text-left py-2 px-3 text-xs font-mono text-text-muted tracking-wider">运动</th>
              </tr>
            </thead>
            <tbody>
              {PB_ROWS.map((row) => {
                const entry = byCode.get(row.code)
                return (
                  <tr
                    key={row.code}
                    className="border-b border-border-subtle hover:bg-bg-card-hover transition-colors"
                  >
                    <td className="py-2.5 px-3 font-mono text-text-secondary">{row.label}</td>
                    <td className="py-2.5 px-3 text-right font-mono font-medium text-accent-green">
                      {entry ? fmtClock(entry.pb_time_sec) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-text-secondary">
                      {entry ? fmtPace(entry.pb_time_sec, row.km) : '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-text-muted text-xs">
                      {entry ? entry.achieved_at : '—'}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-xs">
                      {entry ? (
                        <Link
                          to={`/activity/${entry.label_id}`}
                          title={entry.name ?? undefined}
                          className="text-accent-green hover:opacity-75 transition-opacity"
                        >
                          {entry.name || '查看'}
                        </Link>
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
