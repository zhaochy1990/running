import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getActivity, resyncActivity, regenerateCommentary, formatDate, sportColor, trainTypeColor, sportNameCN, trainTypeCN, type Activity, type Lap, type Segment, type Zone, type TimeseriesPoint } from '../api'
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
  const [syncing, setSyncing] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenError, setRegenError] = useState<string | null>(null)
  const [hoverElapsed, setHoverElapsed] = useState<number | null>(null)

  const loadActivity = () => {
    if (!id || !user) return
    getActivity(user, id).then((data) => {
      setActivity(data.activity)
      setLaps(data.laps)
      setSegments(data.segments || [])
      setZones(data.zones)
      setTimeseries(data.timeseries)
    })
  }

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

  const handleResync = async () => {
    if (!id || !user || syncing) return
    setSyncing(true)
    try {
      const res = await resyncActivity(user, id)
      if (res.success) {
        loadActivity()
      }
    } finally {
      setSyncing(false)
    }
  }

  const handleRegenerate = async () => {
    if (!id || !user || regenerating) return
    setRegenerating(true)
    setRegenError(null)
    try {
      const res = await regenerateCommentary(user, id)
      if (res.success) {
        loadActivity()
      } else {
        setRegenError(res.error || '重新生成失败')
      }
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : 'unknown error')
    } finally {
      setRegenerating(false)
    }
  }

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
  const sharedStartTs = timeseries.find((p) => p.timestamp != null)?.timestamp ?? undefined

  return (
    <div className="max-w-5xl mx-auto px-8 py-8 animate-fade-in">
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
          <button
            onClick={handleResync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 text-xs font-mono text-text-muted hover:text-accent-green transition-colors px-3 py-1.5 rounded-lg border border-border-subtle hover:border-accent-green/30 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title="从 COROS 重新同步此活动"
          >
            <svg className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {syncing ? '同步中...' : '重新同步'}
          </button>
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mt-6 pt-6 border-t border-border-subtle">
          {!isStrength && <BigMetric label="距离" value={`${activity.distance_km}`} unit="km" color="#00a85a" />}
          <BigMetric label="时长" value={activity.duration_fmt} color="#0097a7" />
          {!isStrength && <BigMetric label="平均配速" value={activity.pace_fmt} color="#00a85a" />}
          <BigMetric label="平均心率" value={activity.avg_hr ? `${activity.avg_hr}` : '—'} unit="bpm" color="#d32f2f" />
          <BigMetric label="最大心率" value={activity.max_hr ? `${activity.max_hr}` : '—'} unit="bpm" color="#c62828" />
          <BigMetric label="卡路里" value={activity.calories_kcal ? `${activity.calories_kcal}` : '—'} unit="kcal" color="#e68a00" />
        </div>

        {/* Secondary Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4 mt-4 pt-4 border-t border-border-subtle">
          {!isStrength && <SmallMetric label="步频" value={activity.avg_cadence ? `${activity.avg_cadence} spm` : '—'} />}
          {!isStrength && <SmallMetric label="累计爬升" value={activity.ascent_m ? `${activity.ascent_m} m` : '—'} />}
          <SmallMetric label="训练负荷" value={activity.training_load ? `${activity.training_load.toFixed(0)}` : '—'} />
          {!isStrength && <SmallMetric label="最大摄氧量" value={activity.vo2max ? `${activity.vo2max.toFixed(1)}` : '—'} />}
          <SmallMetric label="有氧效果" value={activity.aerobic_effect ? `${activity.aerobic_effect.toFixed(1)}` : '—'} />
          <SmallMetric label="无氧效果" value={activity.anaerobic_effect ? `${activity.anaerobic_effect.toFixed(1)}` : '—'} />
        </div>

        {/* Weather */}
        {activity.temperature != null && (
          <div className="flex items-center gap-6 mt-4 pt-4 border-t border-border-subtle">
            <div className="flex items-center gap-1.5 text-sm font-mono text-text-secondary">
              <span className="text-xs text-text-muted uppercase tracking-wider mr-1">天气</span>
              <span style={{ color: activity.temperature >= 25 ? '#d32f2f' : activity.temperature >= 15 ? '#e68a00' : '#0097a7' }}>
                {activity.temperature}°C
              </span>
              {activity.feels_like != null && activity.feels_like !== activity.temperature && (
                <span className="text-text-muted text-xs">(体感 {activity.feels_like}°C)</span>
              )}
            </div>
            {activity.humidity != null && (
              <div className="flex items-center gap-1 text-sm font-mono text-text-secondary">
                <span className="text-xs text-text-muted uppercase tracking-wider mr-1">湿度</span>
                {activity.humidity}%
              </div>
            )}
            {activity.wind_speed != null && activity.wind_speed > 0 && (
              <div className="flex items-center gap-1 text-sm font-mono text-text-secondary">
                <span className="text-xs text-text-muted uppercase tracking-wider mr-1">风速</span>
                {activity.wind_speed} km/h
              </div>
            )}
          </div>
        )}

        {/* Sport Note / Feedback */}
        {activity.sport_note && (
          <div className="mt-4 pt-4 border-t border-border-subtle">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-text-muted uppercase tracking-wider">训练反馈</span>
              {activity.feel_type != null && (
                <span className="text-lg leading-none">
                  {[,'😄','🙂','😐','😞','😫'][activity.feel_type] || ''}
                </span>
              )}
            </div>
            <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{activity.sport_note}</p>
          </div>
        )}
      </div>

      {/* Charts & Zones */}
      {isStrength ? (
        /* Strength: HR chart (2/3) + HR zones (1/3) on one row */
        (timeseries.length > 0 || hrZones.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            {timeseries.length > 0 && (
              <div className="lg:col-span-2 bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-1 opacity-0" style={{ animationFillMode: 'forwards' }}>
                <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">心率曲线</h3>
                <HRChart data={timeseries} />
              </div>
            )}
            {hrZones.length > 0 && (
              <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-2 opacity-0" style={{ animationFillMode: 'forwards' }}>
                <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">心率区间</h3>
                <ZoneChart zones={hrZones} type="hr" />
              </div>
            )}
          </div>
        )
      ) : (
        /* Running: separate chart row + zones row */
        <>
          {timeseries.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-1 opacity-0" style={{ animationFillMode: 'forwards' }}>
                <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">心率曲线</h3>
                <HRChart data={timeseries} startTs={sharedStartTs} hoverElapsed={hoverElapsed} onHover={setHoverElapsed} />
              </div>
              <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-2 opacity-0" style={{ animationFillMode: 'forwards' }}>
                <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">配速曲线</h3>
                <PaceChart data={timeseries} startTs={sharedStartTs} hoverElapsed={hoverElapsed} onHover={setHoverElapsed} />
              </div>
            </div>
          )}
          {(hrZones.length > 0 || paceZones.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              {hrZones.length > 0 && (
                <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-3 opacity-0" style={{ animationFillMode: 'forwards' }}>
                  <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">心率区间</h3>
                  <ZoneChart zones={hrZones} type="hr" />
                </div>
              )}
              {paceZones.length > 0 && (
                <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 animate-fade-in stagger-4 opacity-0" style={{ animationFillMode: 'forwards' }}>
                  <h3 className="text-sm font-semibold text-text-secondary mb-4 tracking-wide">配速区间</h3>
                  <ZoneChart zones={paceZones} type="pace" />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Coach commentary */}
      {(activity.commentary || activity.commentary_generated_by) && (
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-5 mb-6 animate-fade-in stagger-5 opacity-0" style={{ animationFillMode: 'forwards' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-text-secondary tracking-wide">教练简评</h3>
              {activity.commentary_generated_by && (
                <span
                  className="inline-flex items-center text-[10px] font-mono px-2 py-0.5 rounded-md"
                  style={{
                    color: '#7c4dff',
                    backgroundColor: '#7c4dff15',
                  }}
                  title={activity.commentary_generated_at ? `生成于 ${activity.commentary_generated_at}` : undefined}
                >
                  Generated by {activity.commentary_generated_by}
                </span>
              )}
            </div>
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              className="inline-flex items-center gap-1.5 text-xs font-mono text-text-muted hover:text-accent-amber transition-colors px-3 py-1.5 rounded-lg border border-border-subtle hover:border-accent-amber/30 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="让 AOAI 重新生成评论（覆盖现有）"
            >
              <svg className={`w-3.5 h-3.5 ${regenerating ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {regenerating ? '生成中...' : '重新生成'}
            </button>
          </div>
          {regenError && (
            <p className="text-xs font-mono text-accent-red mb-3">{regenError}</p>
          )}
          {activity.commentary ? (
            <div className="prose max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{activity.commentary}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-text-muted">（暂无点评 — 点击"重新生成"让 AI 写一条）</p>
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
      <p className="text-xs font-mono text-text-muted uppercase tracking-wider mb-1">{label}</p>
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
      <p className="text-xs font-mono text-text-muted uppercase tracking-wider">{label}</p>
      <p className="text-sm font-mono text-text-secondary mt-0.5">{value}</p>
    </div>
  )
}
