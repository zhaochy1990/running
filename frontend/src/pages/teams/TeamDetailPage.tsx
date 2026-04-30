import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  deleteTeam, getTeam, getTeamMembers, getTeamFeed, joinTeam, leaveTeam, listMyTeams, syncTeamAll,
  transferTeamOwner,
  formatDate, weekdayCN, sportNameCN,
  type Team, type TeamMember, type TeamFeedActivity, type TeamSyncSummary,
} from '../../api'
import { useUserId } from '../../store/authStore'

export default function TeamDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const currentUserId = useUserId()
  const [team, setTeam] = useState<Team | null>(null)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [feed, setFeed] = useState<TeamFeedActivity[]>([])
  const [isMember, setIsMember] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncSummary, setSyncSummary] = useState<TeamSyncSummary | null>(null)
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string> | null>(null)
  const [transferTargetId, setTransferTargetId] = useState('')
  const [ownerActionBusy, setOwnerActionBusy] = useState(false)
  const [dissolveConfirm, setDissolveConfirm] = useState('')

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

  // Default-select every member on first load. Later, when the member list
  // changes (e.g. after sync or a join/leave), keep the user's existing
  // selection but auto-include any new members and drop ids that vanished.
  useEffect(() => {
    if (members.length === 0) return
    setSelectedUserIds((prev) => {
      const memberIds = members.map((m) => m.user_id)
      if (prev === null) return new Set(memberIds)
      const next = new Set<string>()
      const memberIdSet = new Set(memberIds)
      for (const id of prev) if (memberIdSet.has(id)) next.add(id)
      for (const id of memberIds) if (!prev.has(id)) next.add(id)
      return next
    })
  }, [members])

  const toggleMemberSelection = (userId: string) => {
    setSelectedUserIds((prev) => {
      const base = prev ?? new Set(members.map((m) => m.user_id))
      const next = new Set(base)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  const allSelected =
    selectedUserIds !== null &&
    members.length > 0 &&
    members.every((m) => selectedUserIds.has(m.user_id))

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedUserIds(new Set())
    } else {
      setSelectedUserIds(new Set(members.map((m) => m.user_id)))
    }
  }

  const filteredFeed =
    selectedUserIds === null ? feed : feed.filter((a) => selectedUserIds.has(a.user_id))

  const isOwner = Boolean(
    currentUserId &&
    (team?.owner_user_id === currentUserId ||
      members.some((m) => m.user_id === currentUserId && m.role === 'owner')),
  )
  const transferCandidates = members.filter((m) => m.user_id !== currentUserId)

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

  const handleSyncAll = async () => {
    if (!id || syncing) return
    setSyncing(true)
    setError(null)
    try {
      const res = await syncTeamAll(id)
      if (!res.ok) throw new Error(`同步失败 (${res.status})`)
      setSyncSummary(res.data)
      loadAll()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '同步失败')
    } finally {
      setSyncing(false)
    }
  }

  const handleTransferOwner = async () => {
    if (!id || !transferTargetId || ownerActionBusy) return
    setOwnerActionBusy(true)
    setError(null)
    try {
      const res = await transferTeamOwner(id, transferTargetId)
      if (!res.ok) throw new Error(`转让失败 (${res.status})`)
      setTransferTargetId('')
      loadAll()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '转让失败')
    } finally {
      setOwnerActionBusy(false)
    }
  }

  const handleDissolveTeam = async () => {
    if (!id || !team || dissolveConfirm.trim() !== team.name || ownerActionBusy) return
    setOwnerActionBusy(true)
    setError(null)
    try {
      const res = await deleteTeam(id)
      if (!res.ok) throw new Error(`解散失败 (${res.status})`)
      navigate('/teams', { replace: true })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '解散失败')
    } finally {
      setOwnerActionBusy(false)
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
    <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8">
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
        <div className="flex items-center gap-2">
          {isMember && (
            <button
              onClick={handleSyncAll}
              disabled={syncing}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-accent-green/40 text-accent-green hover:bg-accent-green/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {syncing ? (
                <span className="inline-flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
                  同步中...
                </span>
              ) : (
                '同步所有人手表数据'
              )}
            </button>
          )}
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
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-accent-red/30 bg-accent-red/5 text-sm text-accent-red font-mono">
          {error}
        </div>
      )}

      <div className="grid gap-8 grid-cols-1 lg:grid-cols-[2fr_1fr]">
        {/* Activity feed */}
        <section>
          <h2 className="text-xs font-mono text-text-muted tracking-wider mb-3">
            最近 30 天动态
            {selectedUserIds !== null && filteredFeed.length !== feed.length && (
              <span className="ml-2 text-text-secondary">
                ({filteredFeed.length}/{feed.length})
              </span>
            )}
          </h2>
          {feed.length === 0 ? (
            <div className="px-4 py-8 rounded-lg border border-border-subtle text-center text-sm text-text-muted font-mono">
              暂无动态
            </div>
          ) : filteredFeed.length === 0 ? (
            <div className="px-4 py-8 rounded-lg border border-border-subtle text-center text-sm text-text-muted font-mono">
              已隐藏全部成员的动态，请在右侧选择要查看的成员
            </div>
          ) : (
            <div className="space-y-2">
              {filteredFeed.map((act) => (
                <button
                  key={`${act.user_id}-${act.label_id}`}
                  onClick={() => navigate(`/teams/${id}/activity/${act.user_id}/${act.label_id}`)}
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

        {/* Sync summary modal */}
        {syncSummary && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
            onClick={() => setSyncSummary(null)}
          >
            <div
              className="bg-bg-card border border-border rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-text-primary">同步完成</h3>
                  <p className="text-xs font-mono text-text-muted mt-1">
                    {syncSummary.totals.synced}/{syncSummary.totals.members} 名成员同步成功
                    {syncSummary.totals.skipped > 0 && ` · ${syncSummary.totals.skipped} 名跳过`}
                    {syncSummary.totals.errors > 0 && ` · ${syncSummary.totals.errors} 名失败`}
                  </p>
                </div>
                <button
                  onClick={() => setSyncSummary(null)}
                  className="text-text-muted hover:text-text-primary text-xl leading-none px-2"
                  aria-label="关闭"
                >
                  ×
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4 text-xs font-mono">
                <div className="bg-bg-secondary rounded-lg p-3">
                  <div className="text-text-muted">新增活动</div>
                  <div className="text-lg text-accent-green mt-1">
                    {syncSummary.totals.new_activities}
                  </div>
                </div>
                <div className="bg-bg-secondary rounded-lg p-3">
                  <div className="text-text-muted">新增健康记录</div>
                  <div className="text-lg text-accent-green mt-1">
                    {syncSummary.totals.new_health}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {syncSummary.results.map((r) => (
                  <div
                    key={r.user_id}
                    className="px-3 py-2 rounded-lg border border-border-subtle bg-bg-secondary text-sm"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-text-primary truncate">
                        {r.display_name}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                          r.status === 'synced'
                            ? 'text-accent-green bg-accent-green/10'
                            : r.status === 'skipped_no_auth'
                            ? 'text-text-muted bg-bg-card'
                            : 'text-accent-red bg-accent-red/10'
                        }`}
                      >
                        {r.status === 'synced'
                          ? '已同步'
                          : r.status === 'skipped_no_auth'
                          ? '未登录 COROS'
                          : '失败'}
                      </span>
                    </div>
                    {r.status === 'synced' && (r.new_activities > 0 || r.new_health > 0) && (
                      <div className="text-xs font-mono text-text-secondary mt-1">
                        +{r.new_activities} 活动 · +{r.new_health} 健康
                      </div>
                    )}
                    {r.status === 'synced' && r.new_activities === 0 && r.new_health === 0 && (
                      <div className="text-xs font-mono text-text-muted mt-1">无新数据</div>
                    )}
                    {r.status === 'error' && r.error && (
                      <div className="text-xs font-mono text-accent-red mt-1 break-all">
                        {r.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Members sidebar */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-mono text-text-muted tracking-wider">
              成员 ({members.length})
            </h2>
            {members.length > 0 && (
              <button
                onClick={toggleSelectAll}
                className="text-[11px] font-mono text-text-muted hover:text-text-secondary transition-colors"
              >
                {allSelected ? '全不选' : '全选'}
              </button>
            )}
          </div>
          <p className="text-[11px] font-mono text-text-muted mb-2">点击成员可筛选动态</p>
          <div className="space-y-2">
            {members.map((m) => {
              const selected = selectedUserIds === null || selectedUserIds.has(m.user_id)
              return (
                <button
                  key={m.user_id}
                  onClick={() => toggleMemberSelection(m.user_id)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${
                    selected
                      ? 'border-accent-red/40 bg-accent-red/5 hover:bg-accent-red/10'
                      : 'border-border-subtle bg-bg-card opacity-50 hover:opacity-80'
                  }`}
                  aria-pressed={selected}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-flex items-center justify-center w-4 h-4 rounded border flex-shrink-0 ${
                          selected
                            ? 'bg-accent-red border-accent-red text-white'
                            : 'border-border bg-bg-card'
                        }`}
                        aria-hidden
                      >
                        {selected && (
                          <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M2 6.5L5 9L10 3.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <span className="text-sm font-medium text-text-primary truncate">
                        {m.display_name || m.name || m.user_id.slice(0, 8)}
                      </span>
                    </span>
                    {m.role === 'owner' && (
                      <span className="text-[10px] font-mono text-accent-red bg-accent-red/10 px-1.5 py-0.5 rounded flex-shrink-0">
                        OWNER
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          {isOwner && (
            <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
              <h3 className="text-xs font-mono text-red-400 tracking-wider mb-2">
                队长操作
              </h3>
              <p className="text-xs text-text-muted mb-3">
                注销账号前，需要先转让或解散你拥有的团队。
              </p>

              <label className="block text-[11px] font-mono text-text-muted mb-1">
                转让队长给成员
              </label>
              <div className="flex gap-2">
                <select
                  value={transferTargetId}
                  onChange={(e) => setTransferTargetId(e.target.value)}
                  disabled={ownerActionBusy || transferCandidates.length === 0}
                  className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-bg-base px-2 py-2 text-xs text-text-primary focus:border-accent-green focus:outline-none disabled:opacity-50"
                >
                  <option value="">选择成员</option>
                  {transferCandidates.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.display_name || m.name || m.user_id.slice(0, 8)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleTransferOwner}
                  disabled={ownerActionBusy || !transferTargetId}
                  className="rounded-lg border border-accent-green/40 px-3 py-2 text-xs font-medium text-accent-green hover:bg-accent-green/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  转让
                </button>
              </div>
              {transferCandidates.length === 0 && (
                <p className="mt-2 text-[11px] text-text-muted">
                  当前没有其他成员可接任队长。
                </p>
              )}

              <div className="mt-4 border-t border-red-500/20 pt-4">
                <label className="block text-[11px] font-mono text-text-muted mb-1">
                  输入团队名称确认解散
                </label>
                <input
                  type="text"
                  value={dissolveConfirm}
                  onChange={(e) => setDissolveConfirm(e.target.value)}
                  className="w-full rounded-lg border border-red-500/30 bg-bg-base px-2 py-2 text-xs text-text-primary focus:border-red-500 focus:outline-none"
                  placeholder={team.name}
                />
                <button
                  type="button"
                  onClick={handleDissolveTeam}
                  disabled={ownerActionBusy || dissolveConfirm.trim() !== team.name}
                  className="mt-2 w-full rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {ownerActionBusy ? '处理中...' : '解散团队'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
