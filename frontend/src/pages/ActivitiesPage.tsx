import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import {
  formatDateShort,
  getAllActivities,
  sportNameCN,
  type Activity,
} from '../api'
import ViewHead from '../components/ViewHead'
import { shanghaiToday } from '../lib/shanghai'
import { useUser } from '../UserContextValue'
import {
  activityIconLabel,
  filterActivities,
  formatHoursMinutes,
  formatPaceSeconds,
  groupActivitiesByMonth,
  monthRangeFromShanghaiToday,
  paginateActivities,
  summarizeActivities,
  type ActivitySportFilter,
} from './activitiesPageModel'

type LoadState = 'idle' | 'loading' | 'error' | 'ready'

export default function ActivitiesPage() {
  const { user } = useUser()
  const monthRange = useMemo(() => monthRangeFromShanghaiToday(shanghaiToday()), [])
  const [activities, setActivities] = useState<Activity[]>([])
  const [monthActivities, setMonthActivities] = useState<Activity[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [error, setError] = useState('')
  const [sportFilter, setSportFilter] = useState<ActivitySportFilter>('all')
  const [minDistanceKm, setMinDistanceKm] = useState(0)
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo] = useState('')
  const [appliedRange, setAppliedRange] = useState<{ dateFrom?: string; dateTo?: string }>({})
  const [page, setPage] = useState(1)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoadState('loading')
    setError('')

    Promise.all([
      getAllActivities(user, appliedRange),
      getAllActivities(user, { dateFrom: monthRange.dateFrom, dateTo: monthRange.dateTo }),
    ])
      .then(([allActivities, currentMonthActivities]) => {
        if (cancelled) return
        setActivities(allActivities)
        setMonthActivities(currentMonthActivities)
        setLoadState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoadState('error')
      })

    return () => {
      cancelled = true
    }
  }, [appliedRange, monthRange.dateFrom, monthRange.dateTo, user])

  useEffect(() => {
    setPage(1)
  }, [appliedRange, minDistanceKm, sportFilter])

  const filteredActivities = useMemo(
    () => filterActivities(activities, { sport: sportFilter, minDistanceKm }),
    [activities, minDistanceKm, sportFilter],
  )
  const summary = useMemo(() => summarizeActivities(monthActivities), [monthActivities])
  const pageData = useMemo(() => paginateActivities(filteredActivities, page), [filteredActivities, page])
  const monthGroups = useMemo(() => groupActivitiesByMonth(pageData.items), [pageData.items])
  const loading = loadState === 'idle' || loadState === 'loading'

  const applyDateRange = () => {
    const from = draftFrom.trim()
    const to = draftTo.trim()
    if (from && to && from > to) {
      setDraftFrom(to)
      setDraftTo(from)
      setAppliedRange({ dateFrom: to, dateTo: from })
      return
    }
    setAppliedRange({
      ...(from ? { dateFrom: from } : {}),
      ...(to ? { dateTo: to } : {}),
    })
  }

  const resetDateRange = () => {
    setDraftFrom('')
    setDraftTo('')
    setAppliedRange({})
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <ViewHead
        eyebrow="活动记录 · 全部"
        title="活动列表"
        lede="来自 COROS / Garmin 自动同步并匹配课次。点击任意活动查看完整详情、分段与教练点评。"
      />

      <section className="mb-5">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted">
          {`本月统计 · ${monthRange.label}`}
        </div>
        <div className="grid grid-cols-2 overflow-hidden rounded-[11px] border border-border-subtle bg-border-subtle lg:grid-cols-6 gap-px">
          <SummaryCell label="本月跑量" value={summary.totalRunKm.toFixed(1)} unit="km" />
          <SummaryCell label="跑步时长" value={formatHoursValue(summary.runDurationS)} unit="h" />
          <SummaryCell label="平均配速" value={formatPaceSeconds(summary.avgPaceSecPerKm)} unit="/km" />
          <SummaryCell label="平均心率" value={summary.avgRunHr == null ? '--' : String(summary.avgRunHr)} unit="bpm" />
          <SummaryCell label="力量训练" value={String(summary.strengthCount)} unit="次" />
          <SummaryCell label="力量时长" value={String(Math.round(summary.strengthDurationS / 60))} unit="min" />
        </div>
      </section>

      <section className="mb-4 flex flex-wrap items-center gap-2.5 rounded-[11px] border border-border-subtle bg-bg-card px-3 py-2.5">
        <label className="sr-only" htmlFor="activity-sport-filter">活动类型</label>
        <select
          id="activity-sport-filter"
          aria-label="活动类型"
          value={sportFilter}
          onChange={(event) => setSportFilter(event.target.value as ActivitySportFilter)}
          className="h-9 rounded-[7px] border border-border bg-bg-primary px-3 pr-8 font-mono text-xs font-medium text-text-primary outline-none transition-colors hover:border-text-muted focus:border-accent-green"
        >
          <option value="all">类型 · 全部</option>
          <option value="run">类型 · 跑步</option>
          <option value="strength">类型 · 力量训练</option>
        </select>

        <label className="sr-only" htmlFor="activity-distance-filter">距离下限</label>
        <select
          id="activity-distance-filter"
          aria-label="距离下限"
          value={minDistanceKm}
          onChange={(event) => setMinDistanceKm(Number(event.target.value) || 0)}
          className="h-9 rounded-[7px] border border-border bg-bg-primary px-3 pr-8 font-mono text-xs font-medium text-text-primary outline-none transition-colors hover:border-text-muted focus:border-accent-green"
        >
          {[0, 5, 10, 15, 20, 25, 30, 35, 40].map((distance) => (
            <option key={distance} value={distance}>
              {distance === 0 ? '距离 · 全部' : `距离 · >= ${distance} km`}
            </option>
          ))}
        </select>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] tracking-[0.04em] text-text-muted">时间</span>
          <label className="sr-only" htmlFor="activity-from">开始日期</label>
          <input
            id="activity-from"
            aria-label="开始日期"
            type="date"
            value={draftFrom}
            onChange={(event) => setDraftFrom(event.target.value)}
            className="h-9 rounded-[7px] border border-border bg-bg-primary px-2.5 font-mono text-xs text-text-primary outline-none transition-colors hover:border-text-muted focus:border-accent-green"
          />
          <span className="font-mono text-xs text-text-muted">-&gt;</span>
          <label className="sr-only" htmlFor="activity-to">结束日期</label>
          <input
            id="activity-to"
            aria-label="结束日期"
            type="date"
            value={draftTo}
            onChange={(event) => setDraftTo(event.target.value)}
            className="h-9 rounded-[7px] border border-border bg-bg-primary px-2.5 font-mono text-xs text-text-primary outline-none transition-colors hover:border-text-muted focus:border-accent-green"
          />
          <button
            type="button"
            onClick={applyDateRange}
            className="h-9 rounded-[7px] border border-text-primary bg-text-primary px-3.5 text-xs font-semibold text-bg-card transition-opacity hover:opacity-85"
          >
            应用
          </button>
          <button
            type="button"
            onClick={resetDateRange}
            className="h-9 rounded-[7px] border border-border-subtle bg-transparent px-3 text-xs text-text-secondary transition-colors hover:border-border hover:text-text-primary"
          >
            重置
          </button>
        </div>
      </section>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-6 w-6 rounded-full border-2 border-accent-green/30 border-t-accent-green animate-spin" />
        </div>
      )}

      {loadState === 'error' && (
        <div className="rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 font-mono text-sm text-accent-red">
          加载失败：{error}
        </div>
      )}

      {!loading && loadState !== 'error' && filteredActivities.length === 0 && (
        <div className="rounded-[11px] border border-dashed border-border-subtle px-7 py-8 text-center text-xs text-text-muted">
          该范围暂无活动记录。
        </div>
      )}

      {!loading && loadState !== 'error' && filteredActivities.length > 0 && (
        <>
          <div className="space-y-4">
            {monthGroups.map((group) => (
              <MonthSection key={group.key} label={group.label} activities={group.activities} />
            ))}
          </div>
          <Pager
            page={pageData.page}
            totalPages={pageData.totalPages}
            total={filteredActivities.length}
            start={pageData.start}
            shown={pageData.items.length}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  )
}

function SummaryCell({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="bg-bg-card px-4 py-3">
      <div className="font-mono text-[19px] font-semibold tracking-normal text-text-primary">
        {value}<span className="ml-1 text-[11px] font-medium text-text-muted">{unit}</span>
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
    </div>
  )
}

function MonthSection({ label, activities }: { label: string; activities: Activity[] }) {
  const monthSummary = summarizeActivities(activities)
  const duration = formatHoursMinutes(activities.reduce((sum, activity) => sum + activity.duration_s, 0))

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3 px-0.5">
        <h2 className="m-0 text-sm font-semibold tracking-normal text-text-primary">{label}</h2>
        <div className="font-mono text-[11px] text-text-muted">
          {activities.length} 节 · {monthSummary.totalRunKm.toFixed(1)} km · {duration}
        </div>
      </div>
      <div className="overflow-hidden rounded-[11px] border border-border-subtle bg-bg-card">
        {activities.map((activity) => (
          <ActivityRow key={activity.label_id} activity={activity} />
        ))}
      </div>
    </section>
  )
}

function ActivityRow({ activity }: { activity: Activity }) {
  const metrics = [
    { label: '距离', value: activity.distance_km > 0 ? `${formatNumber(activity.distance_km)} km` : '--' },
    { label: '配速', value: activity.avg_pace_s_km ? `${activity.pace_fmt || formatPaceSeconds(activity.avg_pace_s_km)}/km` : '--' },
    { label: 'HR 均', value: activity.avg_hr == null ? '--' : String(activity.avg_hr) },
    { label: '步频', value: activity.avg_cadence == null ? '--' : String(Math.round(activity.avg_cadence)) },
    { label: '用时', value: activity.duration_fmt || formatHoursMinutes(activity.duration_s) },
  ]

  return (
    <Link
      to={`/activity/${activity.label_id}`}
      className="grid grid-cols-[32px_1fr_auto] items-center gap-3 border-b border-border-subtle px-3 py-3 text-text-primary transition-colors last:border-b-0 hover:bg-bg-card-hover lg:grid-cols-[32px_1fr_repeat(5,80px)_auto] lg:gap-3.5 lg:py-2.5"
    >
      <span className="grid h-8 w-8 place-items-center rounded-[7px] bg-bg-secondary font-mono text-xs font-semibold text-accent-green">
        {activityIconLabel(activity)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text-primary lg:text-[13px]">
          {activity.name || sportNameCN(activity.sport_name)}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10px] font-normal text-text-muted">
          {formatDateShort(activity.date)} · {sportNameCN(activity.sport_name)}
        </span>
        <span className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] text-text-secondary sm:grid-cols-3 lg:hidden">
          {metrics.slice(0, 4).map(metric => (
            <span key={metric.label} className="min-w-0">
              <span className="mr-1 text-[9px] uppercase tracking-[0.08em] text-text-muted">{metric.label}</span>
              {metric.value}
            </span>
          ))}
        </span>
      </span>
      {metrics.map(metric => (
        <span key={metric.label} className="hidden text-right font-mono text-xs text-text-primary lg:block">
          <span className="mb-0.5 block text-[9px] uppercase tracking-[0.08em] text-text-muted">{metric.label}</span>
          {metric.value}
        </span>
      ))}
      <span className="font-mono text-sm text-text-muted">-&gt;</span>
    </Link>
  )
}

function Pager({
  page,
  totalPages,
  total,
  start,
  shown,
  onPageChange,
}: {
  page: number
  totalPages: number
  total: number
  start: number
  shown: number
  onPageChange: (page: number) => void
}) {
  if (totalPages <= 1) return null
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1)

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="font-mono text-[11px] tracking-[0.04em] text-text-muted">
        显示 {start + 1}-{start + shown} / {total}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={page === 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-[7px] border border-border-subtle bg-bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border hover:text-text-primary disabled:cursor-default disabled:opacity-40"
        >
          上一页
        </button>
        {pages.map((pageNumber) => (
          <button
            key={pageNumber}
            type="button"
            onClick={() => onPageChange(pageNumber)}
            className={`min-w-8 rounded-[7px] border px-2.5 py-1.5 font-mono text-xs font-medium transition-colors ${
              pageNumber === page
                ? 'border-text-primary bg-text-primary text-bg-card'
                : 'border-border-subtle bg-bg-card text-text-secondary hover:border-border hover:text-text-primary'
            }`}
          >
            {pageNumber}
          </button>
        ))}
        <button
          type="button"
          disabled={page === totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-[7px] border border-border-subtle bg-bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border hover:text-text-primary disabled:cursor-default disabled:opacity-40"
        >
          下一页
        </button>
      </div>
    </div>
  )
}

function formatHoursValue(seconds: number): string {
  return (Math.round((seconds / 3600) * 10) / 10).toFixed(1)
}

function formatNumber(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '')
}
