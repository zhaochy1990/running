import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getWeeks, getWeek, formatWeekRange, formatDateShort, weekdayCN,
  sportColor, sportNameCN, trainTypeColor, trainTypeCN,
  type WeekSummary, type WeekDetail, type Activity,
} from '../api'
import { useUser } from '../UserContext'

type Tab = 'plan' | 'activities' | 'feedback'

export default function WeekLayout() {
  const { folder } = useParams<{ folder: string }>()
  const navigate = useNavigate()
  const { user } = useUser()
  const [weeks, setWeeks] = useState<WeekSummary[]>([])
  const [weekDetail, setWeekDetail] = useState<WeekDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('plan')

  useEffect(() => {
    if (!user) return
    getWeeks(user).then((data) => setWeeks(data.weeks))
  }, [user])

  useEffect(() => {
    if (!folder && weeks.length > 0) {
      navigate(`/week/${weeks[0].folder}`, { replace: true })
    }
  }, [weeks, folder, navigate])

  useEffect(() => {
    if (folder && user) {
      setLoadingDetail(true)
      setActiveTab('plan')
      getWeek(user, folder)
        .then(setWeekDetail)
        .finally(() => setLoadingDetail(false))
    }
  }, [folder, user])

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      {loadingDetail ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
        </div>
      ) : weekDetail ? (
        <div className="animate-fade-in">
          {/* Week header */}
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-text-primary tracking-tight">
              {formatWeekRange(weekDetail.date_from, weekDetail.date_to)}
            </h1>
            <div className="flex items-center gap-4 mt-2">
              <Stat label="训练次数" value={`${weekDetail.activity_count}`} />
              <Stat label="总里程" value={`${weekDetail.total_km} km`} accent />
              <Stat label="总时长" value={weekDetail.total_duration_fmt} />
            </div>
          </div>

          {/* Tabs: 计划 → 记录 → 反馈 */}
          <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg w-fit mb-6">
            {weekDetail.plan && (
              <TabButton active={activeTab === 'plan'} onClick={() => setActiveTab('plan')} color="green">
                训练计划
              </TabButton>
            )}
            <TabButton active={activeTab === 'activities'} onClick={() => setActiveTab('activities')} color="green">
              训练记录 ({weekDetail.activity_count})
            </TabButton>
            {weekDetail.feedback && (
              <TabButton active={activeTab === 'feedback'} onClick={() => setActiveTab('feedback')} color="cyan">
                本周反馈
              </TabButton>
            )}
          </div>

          {/* Tab content */}
          {activeTab === 'plan' && weekDetail.plan && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 animate-fade-in">
              <div className="prose max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{weekDetail.plan}</ReactMarkdown>
              </div>
            </div>
          )}
          {activeTab === 'activities' && (
            <ActivityList activities={weekDetail.activities} />
          )}
          {activeTab === 'feedback' && weekDetail.feedback && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 animate-fade-in">
              <div className="prose max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{weekDetail.feedback}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-text-muted text-center py-20 text-sm">请选择一个训练周</div>
      )}
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-sm font-mono font-semibold ${accent ? 'text-accent-green' : 'text-text-primary'}`}>
        {value}
      </span>
    </div>
  )
}

function TabButton({ active, onClick, color, children }: {
  active: boolean; onClick: () => void; color: 'green' | 'cyan'; children: React.ReactNode
}) {
  const activeClass = color === 'cyan' ? 'bg-accent-cyan/15 text-accent-cyan' : 'bg-accent-green/15 text-accent-green'
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all ${
        active ? activeClass : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}

function ActivityList({ activities }: { activities: Activity[] }) {
  if (activities.length === 0) {
    return <div className="text-text-muted text-center py-16 text-sm">本周暂无训练记录</div>
  }

  const byDate = new Map<string, Activity[]>()
  for (const a of activities) {
    const dateKey = a.date?.slice(0, 10) || ''
    const list = byDate.get(dateKey) || []
    list.push(a)
    byDate.set(dateKey, list)
  }

  return (
    <div className="space-y-4">
      {Array.from(byDate.entries()).map(([date, acts], gi) => (
        <div
          key={date}
          className="animate-fade-in opacity-0"
          style={{ animationDelay: `${gi * 60}ms`, animationFillMode: 'forwards' }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold text-text-primary">{formatDateShort(date)}</span>
            <span className="text-xs text-text-muted">{weekdayCN(date)}</span>
          </div>

          <div className="space-y-2">
            {acts.map((a) => (
              <Link key={a.label_id} to={`/activity/${a.label_id}`}>
                <div className="group bg-bg-card border border-border-subtle rounded-xl px-5 py-4 hover:bg-bg-card-hover hover:border-border transition-all duration-200 cursor-pointer">
                  <div className="flex items-center gap-4">
                    <div
                      className="w-1 h-10 rounded-full flex-shrink-0 opacity-70 group-hover:opacity-100 transition-opacity"
                      style={{ backgroundColor: sportColor(a.sport_name) }}
                    />

                    <div className="min-w-[150px]">
                      <p className="text-sm font-medium text-text-primary truncate max-w-[200px]">
                        {a.name || sportNameCN(a.sport_name)}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className="text-xs font-mono px-1.5 py-0.5 rounded"
                          style={{ color: sportColor(a.sport_name), backgroundColor: sportColor(a.sport_name) + '15' }}
                        >
                          {sportNameCN(a.sport_name)}
                        </span>
                        {a.train_type && (
                          <span
                            className="text-xs font-mono px-1.5 py-0.5 rounded"
                            style={{ color: trainTypeColor(a.train_type), backgroundColor: trainTypeColor(a.train_type) + '15' }}
                          >
                            {trainTypeCN(a.train_type)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex-1 flex items-center gap-6">
                      <Metric label="距离" value={`${a.distance_km} km`} accent />
                      <Metric label="时长" value={a.duration_fmt} />
                      <Metric label="配速" value={a.pace_fmt} accent />
                      <Metric label="心率" value={a.avg_hr ? `${a.avg_hr}` : '—'} />
                      <Metric label="步频" value={a.avg_cadence ? `${a.avg_cadence}` : '—'} />
                      {a.temperature != null && (
                        <Metric label="气温" value={`${a.temperature}°`} />
                      )}
                    </div>

                    <div className="text-text-muted group-hover:text-accent-green transition-colors text-sm">
                      &rsaquo;
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-[60px]">
      <p className="text-xs font-mono text-text-muted tracking-wider">{label}</p>
      <p className={`text-sm font-mono font-medium mt-0.5 ${accent ? 'text-text-primary' : 'text-text-secondary'}`}>
        {value}
      </p>
    </div>
  )
}
