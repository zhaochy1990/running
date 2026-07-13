import { Link } from 'react-router-dom'
import { formatDateShort, sportNameCN, type Activity } from '../../api'

export interface WeeklyRecordsTabProps {
  readonly activities: readonly Activity[]
}

export default function WeeklyRecordsTab({ activities }: WeeklyRecordsTabProps) {
  if (activities.length === 0) return <div className="rounded-2xl border border-dashed border-border bg-bg-card py-16 text-center text-sm text-text-muted">本周暂无训练记录</div>
  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card">
      {activities.map((activity) => (
        <Link key={activity.label_id} to={`/activity/${activity.label_id}`} className="grid gap-3 border-b border-border-subtle p-4 last:border-b-0 hover:bg-bg-card-hover sm:grid-cols-[110px_1fr_auto]">
          <span className="font-mono text-xs text-text-muted">{formatDateShort(activity.date)}</span>
          <div><p className="text-sm font-semibold text-text-primary">{activity.name || sportNameCN(activity.sport_name)}</p><p className="mt-1 text-xs text-text-muted">{sportNameCN(activity.sport_name)} · {activity.duration_fmt}</p></div>
          <span className="font-mono text-sm font-bold text-accent-green">{activity.distance_km.toFixed(1)} km</span>
        </Link>
      ))}
    </div>
  )
}
