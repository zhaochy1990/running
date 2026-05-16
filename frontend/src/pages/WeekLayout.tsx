import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  getWeeks, getWeek, getWeekStrength, updateWeeklyFeedback,
  getPlanDays, pushPlannedSession, reparsePlan,
  formatWeekRange, formatDateShort, weekdayCN,
  sportColor, sportNameCN, trainTypeColor, trainTypeCN,
  getMyProfile,
  type WeekSummary, type WeekDetail, type Activity,
  type PlannedSessionRow, type PlanDay, type MyProfile,
} from '../api'
import { shanghaiDate, shanghaiMonthDay, shanghaiToday } from '../lib/shanghai'
import type { PlannedNutrition, StructuredStatus } from '../types/plan'
import type { StrengthTabResponse } from '../types/strength'
import { useUser } from '../UserContextValue'
import PlannedCalendar from '../components/PlannedCalendar'
import PushAllPlannedButton from '../components/PushAllPlannedButton'
import VariantComparisonView from '../components/VariantComparisonView'
import RouteThumbnail from '../components/RouteThumbnail'
import ViewHead from '../components/ViewHead'

function parseFolderTag(folder: string): { phase: string | null; weekNum: string | null } {
  const m = /\(([^)]+)\)\s*$/.exec(folder)
  if (!m) return { phase: null, weekNum: null }
  const inside = m[1].trim()
  const wk = /W(\d+)/i.exec(inside)
  return {
    phase: inside,
    weekNum: wk ? wk[1].padStart(2, '0') : null,
  }
}

type Tab = 'plan' | 'variants' | 'strength' | 'calendar' | 'activities' | 'feedback'

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
  const [myProfile, setMyProfile] = useState<MyProfile | null>(null)
  const [strengthData, setStrengthData] = useState<StrengthTabResponse | null>(null)
  const [strengthLoading, setStrengthLoading] = useState(false)
  const loadingDetail = Boolean(folder && user && loadedFolder !== folder)
  // Pin "today" to Asia/Shanghai so the past-week heuristic doesn't drift for
  // anyone opening the dashboard from a different timezone.
  const _today = shanghaiToday()
  const needsFeedback = weekDetail ? !weekDetail.feedback?.trim() && weekDetail.activity_count > 0 && weekDetail.date_to < _today : false

  // Pull the connected provider once so we can dispatch push capabilities
  // (Garmin doesn't support strength push yet → button shows as "in dev").
  useEffect(() => {
    let cancelled = false
    getMyProfile()
      .then((p) => { if (!cancelled) setMyProfile(p) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const provider = myProfile?.provider ?? 'coros'
  const canPushRun = true
  const canPushStrength = provider === 'coros'

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

  // Load the strength-tab payload for the active week.
  useEffect(() => {
    if (!folder || !user) {
      setStrengthData(null)
      return
    }
    let cancelled = false
    setStrengthLoading(true)
    getWeekStrength(user, folder)
      .then((data) => {
        if (cancelled) return
        setStrengthData(data)
      })
      .catch(() => {
        if (cancelled) return
        setStrengthData({ folder, sessions: [] })
      })
      .finally(() => {
        if (!cancelled) setStrengthLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [folder, user])

  const handlePush = useCallback(
    async (sessionDate: string, sessionIndex: number, targetDate?: string) => {
      if (!user) return
      const res = await pushPlannedSession(user, sessionDate, sessionIndex, targetDate)
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
          {(() => {
            const { phase, weekNum } = parseFolderTag(weekDetail.folder)
            const range = formatWeekRange(weekDetail.date_from, weekDetail.date_to)
            const title = weekNum ? `W${weekNum} · ${range}` : range
            return (
              <>
                <ViewHead
                  eyebrow={phase ?? undefined}
                  title={title}
                />
                <div className="mt-2 mb-6 flex gap-3 flex-wrap text-[12px] text-text-secondary font-mono">
                  <Stat label="训练次数" value={`${weekDetail.activity_count}`} />
                  <Stat label="总里程" value={`${weekDetail.total_km} km`} accent />
                  <Stat label="总时长" value={weekDetail.total_duration_fmt} />
                </div>
              </>
            )
          })()}

          {/* Tabs: 训练计划 → 方案 → 日历 → 记录 → 反馈 */}
          <div className="flex gap-1 p-1 bg-bg-secondary rounded-lg w-fit mb-6">
            {weekDetail.plan && (
              <TabButton active={activeTab === 'plan'} onClick={() => setActiveTab('plan')} color="green">
                训练计划
              </TabButton>
            )}
            {(weekDetail.variants_summary?.total ?? 0) > 0 && (
              <TabButton active={activeTab === 'variants'} onClick={() => setActiveTab('variants')} color="cyan">
                方案 ({weekDetail.variants_summary?.total ?? 0})
              </TabButton>
            )}
            {(strengthData?.sessions.length ?? 0) > 0 && (
              <TabButton active={activeTab === 'strength'} onClick={() => setActiveTab('strength')} color="green">
                力量训练 ({strengthData?.sessions.length ?? 0})
              </TabButton>
            )}
            {structuredStatus !== 'none' && (
              <TabButton active={activeTab === 'calendar'} onClick={() => setActiveTab('calendar')} color="green">
                日历
              </TabButton>
            )}
            <TabButton active={activeTab === 'activities'} onClick={() => setActiveTab('activities')} color="green">
              训练记录 ({weekDetail.activity_count})
            </TabButton>
            <TabButton active={activeTab === 'feedback'} onClick={() => setActiveTab('feedback')} color="cyan">
              本周反馈
              {needsFeedback && (
                <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent-amber inline-block align-middle" />
              )}
            </TabButton>
          </div>

          {/* Tab content */}
          {activeTab === 'plan' && weekDetail.plan && (
            <div className="space-y-3 animate-fade-in">
              <SelectedVariantBar
                summary={weekDetail.variants_summary}
              />
              <AbandonedBanner abandoned={weekDetail.abandoned_scheduled_workouts} />
              <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6">
                <div className="prose max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{weekDetail.plan}</ReactMarkdown>
                </div>
              </div>
            </div>
          )}
          {activeTab === 'variants' && user && folder && (
            <VariantComparisonView user={user} folder={folder} />
          )}
          {activeTab === 'strength' && (
            <StrengthTab data={strengthData} loading={strengthLoading} />
          )}
          {activeTab === 'calendar' && (
            <CalendarTab
              user={user}
              weekDetail={weekDetail}
              planDays={planDays}
              setPlanDays={setPlanDays}
              structuredStatus={structuredStatus}
              onPush={handlePush}
              onReparse={handleReparse}
              reparseBusy={reparseBusy}
              reparseError={reparseError}
              canPushRun={canPushRun}
              canPushStrength={canPushStrength}
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
              activities={weekDetail.activities}
              totalKm={weekDetail.total_km}
              totalDurationFmt={weekDetail.total_duration_fmt}
              activityCount={weekDetail.activity_count}
              dateTo={weekDetail.date_to}
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
  // `dateFrom`/`dateTo` are Shanghai-local YYYY-MM-DD (week-folder format).
  // Parse the bare strings as Shanghai dates and iterate by day — we
  // deliberately do NOT use `new Date(yyyy_mm_dd)` because that parses as
  // UTC midnight and would drift by one day for non-Shanghai browsers.
  const out: string[] = []
  const parse = (s: string): [number, number, number] | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
    return m ? [+m[1], +m[2], +m[3]] : null
  }
  const from = parse(dateFrom)
  const to = parse(dateTo)
  if (!from || !to) return out
  // Use UTC date arithmetic to walk day-by-day; the resulting numbers are
  // calendar values, not instants, so TZ never enters the picture.
  let cur = Date.UTC(from[0], from[1] - 1, from[2])
  const end = Date.UTC(to[0], to[1] - 1, to[2])
  while (cur <= end && out.length < 31) {
    const d = new Date(cur)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
    cur += 24 * 3600 * 1000
  }
  return out
}

function CalendarTab({
  user,
  weekDetail,
  planDays,
  setPlanDays,
  structuredStatus,
  onPush,
  onReparse,
  reparseBusy,
  reparseError,
  canPushRun,
  canPushStrength,
}: {
  user: string | null
  weekDetail: WeekDetail
  planDays: PlanDay[]
  setPlanDays: (days: PlanDay[]) => void
  structuredStatus: StructuredStatus
  onPush: (date: string, sessionIndex: number, targetDate?: string) => Promise<void>
  onReparse: () => void
  reparseBusy: boolean
  reparseError: string | null
  canPushRun: boolean
  canPushStrength: boolean
}) {
  const [batchBusy, setBatchBusy] = useState(false)
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

  // Batch push uses a leaner per-call hook that skips the per-session calendar
  // refresh; we refresh once at the end so the UI doesn't refetch N times.
  const handleBatchPush = useCallback(
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
    },
    [user],
  )

  const handleBatchStateChange = useCallback(
    async (busy: boolean) => {
      setBatchBusy(busy)
      // Refresh the calendar once when the batch finishes so new
      // scheduled_workout_id values surface in the per-row buttons.
      if (!busy && user) {
        try {
          const refreshed = await getPlanDays(
            user,
            weekDetail.date_from,
            weekDetail.date_to,
          )
          setPlanDays(refreshed.days)
        } catch {
          /* surface as per-row error in PushAllPlannedButton results */
        }
      }
    },
    [user, weekDetail.date_from, weekDetail.date_to, setPlanDays],
  )

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

      <PushAllPlannedButton
        sessions={sessions}
        structuredStatus={structuredStatus}
        canPushRun={canPushRun}
        canPushStrength={canPushStrength}
        onPush={(s) => handleBatchPush(s.date, s.session_index)}
        onBatchStateChange={handleBatchStateChange}
      />

      <PlannedCalendar
        weekDates={weekDates}
        sessions={sessions}
        nutrition={nutrition}
        structuredStatus={structuredStatus}
        canPushRun={canPushRun}
        canPushStrength={canPushStrength}
        pushDisabled={batchBusy}
        onPush={(s, targetDate) => onPush(s.date, s.session_index, targetDate)}
      />
    </div>
  )
}

function StrengthTab({
  data, loading,
}: {
  data: StrengthTabResponse | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }
  if (!data || data.sessions.length === 0) {
    return (
      <div className="text-text-muted text-center py-16 text-sm">
        本周没有力量训练
      </div>
    )
  }
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="border border-accent-red/40 bg-accent-red/10 rounded-xl p-3 sm:p-4">
        <p className="text-xs sm:text-sm text-accent-red leading-relaxed">
          <strong>⚠️ 注意：</strong>
          动作清单优先匹配 COROS 内置动作库（推送到手表后有官方动画指导），
          但本页展示的<strong>动作示意图为 AI 生成</strong>，可能存在解剖错误、姿态偏差或方向反转。
          请<strong>仔细鉴别</strong>后再依图执行；以动作要点 / 发力部位文字描述为准，必要时参考手表内置动画或专业视频。
        </p>
      </div>
      {data.sessions.map((sess) => (
        <div
          key={`${sess.date}-${sess.session_index}`}
          className="bg-bg-card border border-border-subtle rounded-2xl p-4 sm:p-6"
        >
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-xs font-mono text-text-muted">
                {formatDateShort(sess.date)} · {weekdayCN(sess.date)}
              </p>
              <h2 className="text-base font-semibold text-text-primary mt-1">
                {sess.summary}
              </h2>
            </div>
            <span className="text-xs font-mono text-accent-green bg-accent-green/10 px-2 py-1 rounded">
              {sess.exercises.length} 个动作
            </span>
          </div>

          {sess.exercises.length === 0 ? (
            <div className="text-text-muted text-sm py-2">
              （仅有总览，无具体动作清单）
            </div>
          ) : (
            <div className="space-y-3">
              {sess.exercises.map((ex, i) => (
                <StrengthExerciseCard key={i} exercise={ex} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function StrengthExerciseCard({
  exercise,
}: {
  exercise: import('../types/strength').StrengthTabExercise
}) {
  const { display_name, sets, target_kind, target_value, rest_seconds,
          image_url, key_points, muscle_focus, common_mistakes, note } = exercise
  const targetUnit = target_kind === 'time_s' ? 's' : '次'
  const setLine = `${sets} × ${target_value}${targetUnit} · 组间 ${rest_seconds}s`

  return (
    <div className="border border-border-subtle rounded-xl p-3 sm:p-4 bg-bg-secondary/40">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">{display_name}</h3>
        <span className="text-xs font-mono text-accent-green whitespace-nowrap">
          {setLine}
        </span>
      </div>
      {image_url && (
        <div className="mt-3 w-full max-w-md mx-auto">
          <img
            src={image_url}
            alt={display_name}
            loading="lazy"
            className="w-full h-auto rounded-lg bg-white object-contain border border-border-subtle"
          />
        </div>
      )}
      {note && (
        <p className="mt-3 text-xs font-mono text-text-muted">{note}</p>
      )}
      {key_points.length > 0 && (
        <DetailBlock title="动作要点" items={key_points} />
      )}
      {muscle_focus.length > 0 && (
        <DetailBlock title="发力部位" items={muscle_focus} inline />
      )}
      {common_mistakes.length > 0 && (
        <DetailBlock title="常见错误" items={common_mistakes} accent="red" />
      )}
    </div>
  )
}

function DetailBlock({
  title, items, inline = false, accent,
}: {
  title: string
  items: string[]
  inline?: boolean
  accent?: 'red'
}) {
  const titleColor = accent === 'red' ? 'text-accent-red' : 'text-text-secondary'
  return (
    <div className="mt-3">
      <p className={`text-[11px] font-mono tracking-wider mb-1 ${titleColor}`}>
        {title}
      </p>
      {inline ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((m, i) => (
            <span
              key={i}
              className="text-xs font-mono bg-accent-cyan/10 text-accent-cyan px-2 py-0.5 rounded"
            >
              {m}
            </span>
          ))}
        </div>
      ) : (
        <ul className="text-xs text-text-secondary space-y-1 list-disc ml-4">
          {items.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
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
  activities, totalKm, totalDurationFmt, activityCount, dateTo,
}: {
  user: string
  folder: string
  feedback: string | undefined
  source: 'db' | 'file' | 'none' | undefined
  updatedAt: string | null | undefined
  onSaved: (detail: WeekDetail) => void
  reload: () => Promise<unknown> | undefined
  activities: Activity[]
  totalKm: number
  totalDurationFmt: string
  activityCount: number
  dateTo: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(feedback || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const weekEnded = dateTo < today

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

  const startWithTemplate = () => {
    let t = `## 本周训练反馈\n\n`
    t += `本周完成 ${activityCount} 次训练，${totalKm} km，总时长 ${totalDurationFmt}。\n\n`
    t += `### 整体感受\n\n\n\n`
    t += `### 身体状态\n\n\n\n`
    t += `### 计划执行\n\n\n\n`
    t += `### 下周建议\n\n`
    setDraft(t)
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
        activityCount > 0 ? (
          <div className="space-y-5 py-4">
            {/* Header */}
            <div className="text-center">
              <h3 className="text-base font-semibold text-text-primary mb-1">写下本周训练反馈</h3>
              <p className="text-xs text-text-muted">
                {weekEnded
                  ? '反馈帮助 AI 更好地规划下周训练'
                  : '记录训练感受，帮助调整后续安排'}
              </p>
            </div>

            {/* Week stats */}
            <div className="flex items-center justify-center gap-4 py-3 bg-bg-secondary rounded-xl">
              <span className="text-sm font-mono font-semibold text-text-primary">{activityCount} 次训练</span>
              <span className="text-sm font-mono font-semibold text-accent-green">{totalKm} km</span>
              <span className="text-sm font-mono text-text-muted">{totalDurationFmt}</span>
            </div>

            {/* Activity mini-list */}
            <div className="space-y-1">
              {activities.slice(0, 7).map(a => (
                <div key={a.label_id} className="flex items-center gap-3 px-3 py-1.5 text-xs font-mono rounded-lg hover:bg-bg-secondary/50">
                  <span className="text-text-muted w-20 flex-shrink-0">{shanghaiMonthDay(a.date)} {weekdayCN(a.date)}</span>
                  <span className="text-text-primary flex-1 truncate">{a.name || a.sport_name}</span>
                  <span className="text-accent-green flex-shrink-0">{a.distance_km} km</span>
                  <span className="text-text-muted flex-shrink-0">{a.duration_fmt}</span>
                </div>
              ))}
              {activities.length > 7 && (
                <p className="text-xs text-text-muted text-center pt-1">...及其他 {activities.length - 7} 次训练</p>
              )}
            </div>

            {/* Guidance */}
            <div className="px-4 py-3 bg-accent-cyan/5 border border-accent-cyan/20 rounded-xl">
              <p className="text-xs font-medium text-accent-cyan mb-2">反馈可以包括</p>
              <div className="grid grid-cols-2 gap-1.5 text-xs text-text-muted">
                <span>· 整体训练感受 (RPE 1-10)</span>
                <span>· 身体状态与恢复</span>
                <span>· 计划执行情况</span>
                <span>· 下周训练建议</span>
              </div>
            </div>

            {/* CTA */}
            <div className="text-center">
              <button
                onClick={startWithTemplate}
                className="px-6 py-2.5 text-sm font-medium rounded-lg bg-accent-cyan/10 border border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/20 transition-all"
              >
                开始写反馈
              </button>
            </div>
          </div>
        ) : (
          <div className="text-text-muted text-center py-12 text-sm">
            本周暂无训练记录
          </div>
        )
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
    // Always group by Shanghai calendar day. `a.date` ships as a
    // Shanghai-offset ISO string from the API, but go through the helper
    // anyway so this stays correct if a future endpoint forgets to convert.
    const dateKey = shanghaiDate(a.date)
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
                    <RouteThumbnail
                      polyline={a.route_thumb}
                      sportName={a.sport_name}
                      size={56}
                      color={sportColor(a.sport_name)}
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

function SelectedVariantBar({
  summary,
}: {
  summary?: WeekDetail['variants_summary']
}) {
  if (!summary || summary.selected_variant_id == null) return null
  const idx = summary.selected_variant_id != null
    ? summary.model_ids.length === 1 ? summary.model_ids[0] : ''
    : ''
  return (
    <div
      data-testid="selected-variant-bar"
      className="flex items-center gap-2 rounded-xl border border-accent-green/30 bg-accent-green/10 px-3 py-1.5 text-xs font-mono text-accent-green"
    >
      <span>已选定 ✓</span>
      {idx && <span className="text-text-secondary">from {idx}</span>}
      <span className="text-text-muted">(variant #{summary.selected_variant_id})</span>
    </div>
  )
}

function AbandonedBanner({
  abandoned,
}: {
  abandoned?: WeekDetail['abandoned_scheduled_workouts']
}) {
  if (!abandoned || abandoned.length === 0) return null
  const dates = abandoned.map((a) => a.date).join('、')
  return (
    <div
      data-testid="abandoned-banner"
      role="alert"
      className="rounded-xl border border-accent-red/30 bg-accent-red/10 px-4 py-2.5 text-xs font-mono text-accent-red"
    >
      <div className="font-semibold mb-1">
        ⚠️ {abandoned.length} 条已推送训练在新计划中没有对应
      </div>
      <div>请到 COROS 删除以避免重复推送: {dates}</div>
    </div>
  )
}
