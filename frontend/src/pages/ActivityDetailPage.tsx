import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getActivity, formatDate, sportColor, trainTypeColor, sportNameCN, trainTypeCN, type Activity, type Lap, type Segment, type Zone, type TimeseriesPoint } from '../api'
import { useUser } from '../UserContext'
import SegmentView from '../components/SegmentView'
import StrengthView from '../components/StrengthView'
import ZoneChart from '../components/ZoneChart'
import HRChart from '../components/HRChart'
import PaceChart from '../components/PaceChart'

export default function ActivityDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useUser()
  const [activity, setActivity] = useState<Activity | null>(null)
  const [laps, setLaps] = useState<Lap[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id || !user) return
    setLoading(true)
    getActivity(user, id)
      .then((data) => {
        setActivity(data.activity)
        setLaps(data.laps)
        setSegments(data.segments || [])
        setZones(data.zones)
        setTimeseries(data.timeseries)
      })
      .finally(() => setLoading(false))
  }, [id])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  if (!activity) {
    return <div className="text-text-muted text-center py-20">未找到该训练记录</div>
  }

  const isStrength = [402, 800].includes(activity.sport_type)
  const hrZones = zones.filter((z) => z.zone_type === 'heartRate')
  const paceZones = zones.filter((z) => z.zone_type === 'pace')

  return (
    <div className="animate-fade-in">
      {/* Back link */}
      <button
        onClick={() => window.history.back()}
        className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent-green transition-colors mb-6 cursor-pointer"
      >
        <span>&lsaquo;</span> 返回
      </button>

      {/* Header Card */}
      <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span
                className="inline-block text-[11px] font-mono font-medium px-2.5 py-1 rounded-lg"
                style={{
                  color: sportColor(activity.sport_name),
                  backgroundColor: sportColor(activity.sport_name) + '15',
                }}
              >
                {sportNameCN(activity.sport_name)}
              </span>
              {activity.train_type && (
                <span
                  className="inline-block text-[11px] font-mono font-medium px-2.5 py-1 rounded-lg"
                  style={{
                    color: trainTypeColor(activity.train_type),
                    backgroundColor: trainTypeColor(activity.train_type) + '15',
                  }}
                >
                  {trainTypeCN(activity.train_type)}
                </span>
              )}
            </div>
            <h1 className="text-xl font-bold text-text-primary tracking-tight">
              {activity.name || sportNameCN(activity.sport_name)}
            </h1>
            <p className="text-sm font-mono text-text-muted mt-1">{formatDate(activity.date)}</p>
          </div>
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mt-6 pt-6 border-t border-border-subtle">
          <BigMetric label="距离" value={`${activity.distance_km}`} unit="km" color="#00e676" />
          <BigMetric label="时长" value={activity.duration_fmt} color="#00e5ff" />
          <BigMetric label="平均配速" value={activity.pace_fmt} color="#00e676" />
          <BigMetric label="平均心率" value={activity.avg_hr ? `${activity.avg_hr}` : '—'} unit="bpm" color="#ff5252" />
          <BigMetric label="最大心率" value={activity.max_hr ? `${activity.max_hr}` : '—'} unit="bpm" color="#ff1744" />
          <BigMetric label="卡路里" value={activity.calories_kcal ? `${activity.calories_kcal}` : '—'} unit="kcal" color="#ffab00" />
        </div>

        {/* Secondary Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mt-4 pt-4 border-t border-border-subtle">
          <SmallMetric label="步频" value={activity.avg_cadence ? `${activity.avg_cadence} spm` : '—'} />
          <SmallMetric label="累计爬升" value={activity.ascent_m ? `${activity.ascent_m} m` : '—'} />
          <SmallMetric label="训练负荷" value={activity.training_load ? `${activity.training_load.toFixed(0)}` : '—'} />
          <SmallMetric label="最大摄氧量" value={activity.vo2max ? `${activity.vo2max.toFixed(1)}` : '—'} />
          <SmallMetric label="有氧效果" value={activity.aerobic_effect ? `${activity.aerobic_effect.toFixed(1)}` : '—'} />
          <SmallMetric label="无氧效果" value={activity.anaerobic_effect ? `${activity.anaerobic_effect.toFixed(1)}` : '—'} />
        </div>

        {/* Weather */}
        {activity.temperature != null && (
          <div className="flex items-center gap-6 mt-4 pt-4 border-t border-border-subtle">
            <div className="flex items-center gap-1.5 text-sm font-mono text-text-secondary">
              <span className="text-[10px] text-text-muted uppercase tracking-wider mr-1">天气</span>
              <span style={{ color: activity.temperature >= 25 ? '#ff5252' : activity.temperature >= 15 ? '#ffab00' : '#00e5ff' }}>
                {activity.temperature}°C
              </span>
              {activity.feels_like != null && activity.feels_like !== activity.temperature && (
                <span className="text-text-muted text-xs">(体感 {activity.feels_like}°C)</span>
              )}
            </div>
            {activity.humidity != null && (
              <div className="flex items-center gap-1 text-sm font-mono text-text-secondary">
                <span className="text-[10px] text-text-muted uppercase tracking-wider mr-1">湿度</span>
                {activity.humidity}%
              </div>
            )}
            {activity.wind_speed != null && activity.wind_speed > 0 && (
              <div className="flex items-center gap-1 text-sm font-mono text-text-secondary">
                <span className="text-[10px] text-text-muted uppercase tracking-wider mr-1">风速</span>
                {activity.wind_speed} km/h
              </div>
            )}
          </div>
        )}
      </div>

      {/* Charts Row */}
      {timeseries.length > 0 && (
        <div className={`grid grid-cols-1 ${isStrength ? '' : 'lg:grid-cols-2'} gap-4 mb-6`}>
          <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-1 opacity-0" style={{ animationFillMode: 'forwards' }}>
            <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">心率曲线</h3>
            <HRChart data={timeseries} />
          </div>
          {!isStrength && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-2 opacity-0" style={{ animationFillMode: 'forwards' }}>
              <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">配速曲线</h3>
              <PaceChart data={timeseries} />
            </div>
          )}
        </div>
      )}

      {/* Zones */}
      {(hrZones.length > 0 || paceZones.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
          {hrZones.length > 0 && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-3 opacity-0" style={{ animationFillMode: 'forwards' }}>
              <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">心率区间</h3>
              <ZoneChart zones={hrZones} type="hr" />
            </div>
          )}
          {!isStrength && paceZones.length > 0 && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-4 opacity-0" style={{ animationFillMode: 'forwards' }}>
              <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">配速区间</h3>
              <ZoneChart zones={paceZones} type="pace" />
            </div>
          )}
        </div>
      )}

      {/* Segments & Laps */}
      {(segments.length > 0 || laps.length > 0) && (
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-5 opacity-0" style={{ animationFillMode: 'forwards' }}>
          <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">
            分段数据
          </h3>
          {isStrength ? <StrengthView segments={segments} /> : <SegmentView segments={segments} laps={laps} />}
        </div>
      )}
    </div>
  )
}

function BigMetric({ label, value, unit, color }: { label: string; value: string; unit?: string; color: string }) {
  return (
    <div>
      <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-1">{label}</p>
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-bold font-mono" style={{ color }}>{value}</span>
        {unit && <span className="text-xs text-text-muted font-mono">{unit}</span>}
      </div>
    </div>
  )
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-mono text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-sm font-mono text-text-secondary mt-0.5">{value}</p>
    </div>
  )
}
