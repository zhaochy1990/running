import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getTeam, getTeamMembers, getTeamFeed, joinTeam, leaveTeam, listMyTeams,
  formatDate, weekdayCN, sportNameCN,
  type Team, type TeamMember, type TeamFeedActivity,
} from '../../api'

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [feed, setFeed] = useState<TeamFeedActivity[]>([])
  const [isMember, setIsMember] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadAll = () => {
    if (!id) return
    setLoading(true)
    setError(null)
    Promise.all([
      getTeam(id),
      getTeamMembers(id),
      getTeamFeed(id, 30),
      listMyTeams(),
    ])
      .then(([t, m, f, mine]) => {
        setTeam(t)
        setMembers(m.members)
        setFeed(f.activities)
        setIsMember(mine.teams.some((x) => x.id === id))
      })
      .catch((e) => setError(e?.message || '加载失败'))
      .finally(() => setLoading(false))
  }

  useEffect(loadAll, [id])

  const toggleMembership = async () => {
    if (!id) return
    setBusy(true)
    try {
      const res = isMember ? await leaveTeam(id) : await joinTeam(id)
      if (!res.ok) throw new Error(`操作失败 (${res.status})`)
      loadAll()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-8 py-20 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent-red/30 border-t-accent-red rounded-full animate-spin" />
      </div>
    )
  }

  if (!team) {
    return (
      <div className="max-w-5xl mx-auto px-8 py-20 text-center">
        <p className="text-text-muted font-mono">团队不存在</p>
        <button onClick={() => navigate('/teams')} className="mt-4 text-sm text-accent-red hover:underline">返回团队列表</button>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
      <button onClick={() => navigate('/teams')} className="text-xs font-mono text-text-muted hover:text-text-secondary mb-4">← 返回</button>

      {/* Team header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">{team.name}</h1>
          {team.description && (
            <p className="text-sm text-text-secondary mt-2 max-w-2xl">{team.description}</p>
          )}
          <p className="text-xs font-mono text-text-muted mt-3">
            {members.length} 名成员
            {team.is_open && <span className="ml-3 text-accent-red">公开</span>}
          </p>
        </div>
        <button
          onClick={toggleMembership}
          disabled={busy}
          className={`px-4 py-2 text-sm font-medium rounded-lg border transition-all disabled:opacity-50 ${
            isMember
              ? 'border-border text-text-muted hover:bg-bg-card'
              : 'border-accent-red/40 text-accent-red hover:bg-accent-red/10'
          }`}
        >
          {busy ? '处理中...' : isMember ? '退出团队' : '加入团队'}
        </button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-accent-red/30 bg-accent-red/5 text-sm text-accent-red font-mono">
          {error}
        </div>
      )}

      <div className="grid gap-8 grid-cols-1 lg:grid-cols-[2fr_1fr]">
        {/* Activity feed */}
        <section>
          <h2 className="text-xs font-mono text-text-muted tracking-wider mb-3">最近 30 天动态</h2>
          {feed.length === 0 ? (
            <div className="px-4 py-8 rounded-lg border border-border-subtle text-center text-sm text-text-muted font-mono">
              暂无动态
            </div>
          ) : (
            <div className="space-y-2">
              {feed.map((act) => (
                <button
                  key={`${act.user_id}-${act.label_id}`}
                  onClick={() => navigate(`/activity/${act.label_id}`)}
                  className="w-full text-left p-4 rounded-xl border border-border-subtle bg-bg-card hover:bg-bg-card-hover transition-all"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-text-primary">{act.display_name}</span>
                    <span className="text-xs font-mono text-text-muted">
                      {weekdayCN(act.date)} {formatDate(act.date)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono text-text-secondary">
                    <span className="text-accent-red">{sportNameCN(act.sport_name)}</span>
                    <span>{act.distance_km} km</span>
                    <span>{act.duration_fmt}</span>
                    <span>{act.pace_fmt}</span>
                    {act.avg_hr && <span>HR {act.avg_hr}</span>}
                  </div>
                  {act.name && (
                    <p className="text-xs text-text-muted mt-2 line-clamp-1">{act.name}</p>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Members sidebar */}
        <section>
          <h2 className="text-xs font-mono text-text-muted tracking-wider mb-3">成员 ({members.length})</h2>
          <div className="space-y-2">
            {members.map((m) => (
              <div
                key={m.user_id}
                className="px-3 py-2 rounded-lg border border-border-subtle bg-bg-card"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-primary truncate">
                    {m.name || m.display_name || m.user_id.slice(0, 8)}
                  </span>
                  {m.role === 'owner' && (
                    <span className="text-[10px] font-mono text-accent-red bg-accent-red/10 px-1.5 py-0.5 rounded">
                      OWNER
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
