import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getWeeks, getWeek, updateWeeklyFeedback,
  formatWeekRange, formatDateShort, weekdayCN,
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
            <TabButton active={activeTab === 'feedback'} onClick={() => setActiveTab('feedback')} color="cyan">
              本周反馈
            </TabButton>
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
          {activeTab === 'feedback' && (
            <FeedbackPanel
              user={user}
              folder={weekDetail.folder}
              feedback={weekDetail.feedback}
              source={weekDetail.feedback_source}
              updatedAt={weekDetail.feedback_updated_at}
              onSaved={(newDetail) => setWeekDetail(newDetail)}
              reload={() => folder && user ? getWeek(user, folder).then(setWeekDetail) : undefined}
            />
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

function FeedbackPanel({
  user, folder, feedback, source, updatedAt, onSaved, reload,
}: {
  user: string
  folder: string
  feedback: string | undefined
  source: 'db' | 'file' | 'none' | undefined
  updatedAt: string | null | undefined
  onSaved: (detail: WeekDetail) => void
  reload: () => Promise<unknown> | undefined
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(feedback || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-sync draft when the underlying feedback changes (e.g. switching weeks)
  useEffect(() => {
    setDraft(feedback || '')
    setEditing(false)
    setError(null)
  }, [feedback, folder])

  const startEdit = () => {
    setDraft(feedback || '')
    setError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setDraft(feedback || '')
    setError(null)
    setEditing(false)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await updateWeeklyFeedback(user, folder, draft)
      if (!res.ok) throw new Error(`保存失败 (${res.status})`)
      const reloaded = await reload()
      if (reloaded && typeof reloaded === 'object' && 'folder' in reloaded) {
        onSaved(reloaded as WeekDetail)
      }
      setEditing(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const isEmpty = !feedback || !feedback.trim()

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-6 animate-fade-in">
      {/* Header: source badge + edit/save controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {source === 'db' && (
            <span className="text-[11px] font-mono text-accent-cyan bg-accent-cyan/10 px-2 py-0.5 rounded">
              已编辑
            </span>
          )}
          {source === 'file' && (
            <span className="text-[11px] font-mono text-text-muted bg-bg-secondary px-2 py-0.5 rounded">
              来自 feedback.md
            </span>
          )}
          {updatedAt && source === 'db' && (
            <span className="text-[11px] font-mono text-text-muted">
              {updatedAt.replace('T', ' ').slice(0, 19)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editing ? (
            <button
              onClick={startEdit}
              className="px-3 py-1.5 text-xs font-medium rounded border border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10 transition-all"
            >
              {isEmpty ? '+ 添加反馈' : '编辑'}
            </button>
          ) : (
            <>
              <button
                onClick={cancelEdit}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded border border-border text-text-muted hover:bg-bg-secondary disabled:opacity-50 transition-all"
              >
                取消
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded border border-accent-cyan/40 text-accent-cyan hover:bg-accent-cyan/10 disabled:opacity-50 transition-all"
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded border border-accent-red/30 bg-accent-red/5 text-xs text-accent-red font-mono">
          {error}
        </div>
      )}

      {editing ? (
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full min-h-[400px] px-4 py-3 rounded-lg border border-border bg-bg-secondary text-sm font-mono text-text-primary focus:border-accent-cyan focus:outline-none resize-y"
            placeholder="支持 Markdown — 写下本周的训练感受、收获、调整..."
          />
          <div className="border border-border-subtle rounded-lg p-4 bg-bg-card overflow-auto min-h-[400px]">
            <p className="text-[11px] font-mono text-text-muted tracking-wider mb-2">预览</p>
            <div className="prose max-w-none">
              {draft.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
              ) : (
                <p className="text-text-muted text-sm">暂无内容</p>
              )}
            </div>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="text-text-muted text-center py-12 text-sm">
          本周还没有反馈 — 点击右上角"添加反馈"开始记录
        </div>
      ) : (
        <div className="prose max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{feedback as string}</ReactMarkdown>
        </div>
      )}
    </div>
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
