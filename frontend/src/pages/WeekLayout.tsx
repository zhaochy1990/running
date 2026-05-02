import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getWeeks, getWeek, updateWeeklyFeedback,
  getPlanDays, pushPlannedSession, reparsePlan,
  formatWeekRange, formatDateShort, weekdayCN,
  sportColor, sportNameCN, trainTypeColor, trainTypeCN,
  type WeekSummary, type WeekDetail, type Activity,
  type PlannedSessionRow, type PlanDay,
} from '../api'
import type { PlannedNutrition, StructuredStatus } from '../types/plan'
import { useUser } from '../UserContextValue'
import PlannedCalendar from '../components/PlannedCalendar'

type Tab = 'plan' | 'calendar' | 'activities' | 'feedback'

export default function WeekLayout() {
  const { folder } = useParams<{ folder: string }>()
  const navigate = useNavigate()
  const { user } = useUser()
  const [weeks, setWeeks] = useState<WeekSummary[]>([])
  const [weekDetail, setWeekDetail] = useState<WeekDetail | null>(null)
  const [loadedFolder, setLoadedFolder] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('plan')
  const [planDays, setPlanDays] = useState<PlanDay[]>([])
  const [structuredStatus, setStructuredStatus] = useState<StructuredStatus>('none')
  const [reparseBusy, setReparseBusy] = useState(false)
  const [reparseError, setReparseError] = useState<string | null>(null)
  const loadingDetail = Boolean(folder && user && loadedFolder !== folder)

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
      let cancelled = false
      getWeek(user, folder)
        .then((data) => {
          if (cancelled) return
          setWeekDetail(data)
          setActiveTab('plan')
          // Pull structured status from the augmented week response.
          const structured = (data as WeekDetail & {
            structured?: { structured_status?: StructuredStatus }
          }).structured
          setStructuredStatus(structured?.structured_status ?? 'none')
        })
        .finally(() => {
          if (!cancelled) setLoadedFolder(folder)
        })
      return () => {
        cancelled = true
      }
    }
  }, [folder, user])

  // Load the calendar payload for the active week.
  useEffect(() => {
    if (!folder || !user || !weekDetail) return
    let cancelled = false
    getPlanDays(user, weekDetail.date_from, weekDetail.date_to)
      .then((data) => {
        if (cancelled) return
        setPlanDays(data.days)
      })
      .catch(() => {
        if (cancelled) return
        setPlanDays([])
      })
    return () => {
      cancelled = true
    }
  }, [folder, user, weekDetail])

  const handlePush = useCallback(
    async (sessionDate: string, sessionIndex: number) => {
      if (!user) return
      const res = await pushPlannedSession(user, sessionDate, sessionIndex)
      if (!res.ok) {
        const detail = res.data?.detail
        const msg = typeof detail === 'string'
          ? detail
          : detail && typeof detail === 'object' && 'error' in detail
            ? String(detail.error ?? '推送失败')
            : `推送失败 (${res.status})`
        throw new Error(msg)
      }
      // Refresh calendar payload to surface the new scheduled_workout_id.
      if (weekDetail) {
        const refreshed = await getPlanDays(user, weekDetail.date_from, weekDetail.date_to)
        setPlanDays(refreshed.days)
      }
    },
    [user, weekDetail],
  )

  const handleReparse = useCallback(async () => {
    if (!folder || !user) return
    setReparseBusy(true)
    setReparseError(null)
    try {
      const res = await reparsePlan(user, folder)
      if (!res.ok) {
        setReparseError(`重新解析失败 (${res.status})`)
        return
      }
      setStructuredStatus(res.data.structured_status)
      // Pull fresh calendar data after the reparse.
      if (weekDetail) {
        const refreshed = await getPlanDays(user, weekDetail.date_from, weekDetail.date_to)
        setPlanDays(refreshed.days)
      }
    } catch (e) {
      setReparseError(e instanceof Error ? e.message : '重新解析失败')
    } finally {
      setReparseBusy(false)
    }
  }, [folder, user, weekDetail])

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8">
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
            <div className="flex items-center flex-wrap gap-4 mt-2">
              <Stat label="训练次数" value={`${weekDetail.activity_count}`} />
              <Stat label="总里程" value={`${weekDetail.total_km} km`} accent />
              <Stat label="总时长" value={weekDetail.total_duration_fmt} />
            </div>
          </div>

          {/* Tabs: 计划 → 日历 → 记录 → 反馈 */}
          <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg w-fit mb-6">
            {weekDetail.plan && (
              <TabButton active={activeTab === 'plan'} onClick={() => setActiveTab('plan')} color="green">
                训练计划
              </TabButton>
            )}
            <TabButton active={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')} color="green">
              日历
            </TabButton>
            <TabButton active={activeTab === 'activities'} onClick={() => setActiveTab('activities')} color="green">
              训练记录 ({weekDetail.activity_count})
            </TabButton>
            <TabButton active={activeTab === 'feedback'} onClick={() => setActiveTab('feedback')} color="cyan">
              本周反馈
            </TabButton>
          </div>

          {/* Tab content */}
          {activeTab === 'plan' && weekDetail.plan && (
            <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6 animate-fade-in">
              <div className="prose max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{weekDetail.plan}</ReactMarkdown>
              </div>
            </div>
          )}
          {activeTab === 'calendar' && (
            <CalendarTab
              weekDetail={weekDetail}
              planDays={planDays}
              structuredStatus={structuredStatus}
              onPush={handlePush}
              onReparse={handleReparse}
              reparseBusy={reparseBusy}
              reparseError={reparseError}
            />
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

function buildWeekDates(dateFrom: string, dateTo: string): string[] {
  const out: string[] = []
  const start = new Date(dateFrom)
  const end = new Date(dateTo)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return out
  const cur = new Date(start)
  while (cur <= end && out.length < 31) {
    const y = cur.getFullYear()
    const m = String(cur.getMonth() + 1).padStart(2, '0')
    const d = String(cur.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${d}`)
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

function CalendarTab({
  weekDetail,
  planDays,
  structuredStatus,
  onPush,
  onReparse,
  reparseBusy,
  reparseError,
}: {
  weekDetail: WeekDetail
  planDays: PlanDay[]
  structuredStatus: StructuredStatus
  onPush: (date: string, sessionIndex: number) => Promise<void>
  onReparse: () => void
  reparseBusy: boolean
  reparseError: string | null
}) {
  const weekDates = buildWeekDates(weekDetail.date_from, weekDetail.date_to)
  const sessions: PlannedSessionRow[] = []
  const nutrition: PlannedNutrition[] = []
  for (const day of planDays) {
    sessions.push(...day.sessions)
    if (day.nutrition) nutrition.push(day.nutrition)
  }

  const showReparse =
    structuredStatus === 'parse_failed' ||
    structuredStatus === 'stale' ||
    structuredStatus === 'none' ||
    structuredStatus === 'backfilled'

  return (
    <div className="space-y-3 animate-fade-in">
      {showReparse && (
        <div
          data-testid="reparse-banner"
          className="flex items-center justify-between gap-3 rounded-xl border border-accent-cyan/30 bg-accent-cyan/10 px-4 py-2.5"
        >
          <p className="text-xs font-mono text-accent-cyan">
            {structuredStatus === 'parse_failed' && '本周计划暂未结构化，请重新解析'}
            {structuredStatus === 'stale' && '结构化数据已过期'}
            {structuredStatus === 'none' && '本周尚无结构化计划'}
            {structuredStatus === 'backfilled' && '历史回填的计划，重新解析后启用推送'}
          </p>
          <div className="flex items-center gap-2">
            {reparseError && (
              <span className="text-[11px] font-mono text-accent-red">{reparseError}</span>
            )}
            <button
              type="button"
              onClick={onReparse}
              disabled={reparseBusy}
              className="px-3 py-1 text-xs font-medium rounded border border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10 transition-all disabled:opacity-50"
            >
              {reparseBusy ? '解析中…' : '重新解析'}
            </button>
          </div>
        </div>
      )}

      <PlannedCalendar
        weekDates={weekDates}
        sessions={sessions}
        nutrition={nutrition}
        structuredStatus={structuredStatus}
        canPushRun={true}
        onPush={(s) => onPush(s.date, s.session_index)}
      />
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
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6 animate-fade-in">
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
                <div className="group bg-bg-card border border-border-subtle rounded-xl px-4 sm:px-5 py-3.5 sm:py-4 hover:bg-bg-card-hover hover:border-border transition-all duration-200 cursor-pointer">
                  <div className="flex items-stretch gap-3 sm:gap-4">
                    <div
                      className="w-1 self-stretch rounded-full flex-shrink-0 opacity-70 group-hover:opacity-100 transition-opacity"
                      style={{ backgroundColor: sportColor(a.sport_name) }}
                    />

                    <div className="flex-1 min-w-0">
                      {/* Name + tags row — desktop also has metrics inline */}
                      <div className="flex items-center gap-3 sm:gap-4">
                        <div className="flex-1 min-w-0 sm:flex-none sm:min-w-[150px]">
                          <p className="text-sm font-medium text-text-primary truncate">
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

                        {/* Desktop-only metrics */}
                        <div className="hidden sm:flex flex-1 items-center gap-6">
                          <Metric label="距离" value={`${a.distance_km} km`} accent />
                          <Metric label="时长" value={a.duration_fmt} />
                          <Metric label="配速" value={a.pace_fmt} accent />
                          <Metric label="心率" value={a.avg_hr ? `${a.avg_hr}` : '—'} />
                          <Metric label="步频" value={a.avg_cadence ? `${a.avg_cadence}` : '—'} />
                          {a.temperature != null && <Metric label="气温" value={`${a.temperature}°`} />}
                        </div>

                        <div className="text-text-muted group-hover:text-accent-green transition-colors text-sm flex-shrink-0">
                          &rsaquo;
                        </div>
                      </div>

                      {/* Mobile-only key metrics */}
                      <div className="flex sm:hidden items-center gap-4 mt-2">
                        <Metric label="距离" value={`${a.distance_km} km`} accent />
                        <Metric label="配速" value={a.pace_fmt} accent />
                        <Metric label="时长" value={a.duration_fmt} />
                        {a.avg_hr ? <Metric label="心率" value={`${a.avg_hr}`} /> : null}
                      </div>
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
    <div>
      <p className="text-xs font-mono text-text-muted tracking-wider">{label}</p>
      <p className={`text-sm font-mono font-medium mt-0.5 ${accent ? 'text-text-primary' : 'text-text-secondary'}`}>
        {value}
      </p>
    </div>
  )
}
