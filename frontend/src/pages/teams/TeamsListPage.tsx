import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listTeams, listMyTeams, joinTeam, type Team, type MyTeam } from '../../api'

export default function TeamsListPage() {
  const navigate = useNavigate()
  const [teams, setTeams] = useState<Team[]>([])
  const [myTeams, setMyTeams] = useState<MyTeam[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState<string | null>(null)

  const loadAll = () => {
    setLoading(true)
    setError(null)
    Promise.all([listTeams(), listMyTeams()])
      .then(([all, mine]) => {
        setTeams(all.teams)
        setMyTeams(mine.teams)
      })
      .catch((e) => setError(e?.message || '加载团队失败'))
      .finally(() => setLoading(false))
  }

  useEffect(loadAll, [])

  const myTeamIds = new Set(myTeams.map((t) => t.id))

  const handleJoin = async (id: string) => {
    setJoining(id)
    try {
      const res = await joinTeam(id)
      if (!res.ok) throw new Error(`加入失败 (${res.status})`)
      loadAll()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '加入失败'
      setError(msg)
    } finally {
      setJoining(null)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">团队</h1>
          <p className="text-sm font-mono text-text-muted mt-1">和队友一起跑</p>
        </div>
        <button
          onClick={() => navigate('/teams/new')}
          className="px-4 py-2 text-sm font-medium rounded-lg border border-accent-red/40 text-accent-red hover:bg-accent-red/10 transition-all"
        >
          + 创建团队
        </button>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg border border-accent-red/30 bg-accent-red/5 text-sm text-accent-red font-mono">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-accent-red/30 border-t-accent-red rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-8">
          {myTeams.length > 0 && (
            <section>
              <h2 className="text-xs font-mono text-text-muted tracking-wider mb-3">我的团队</h2>
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
                {myTeams.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => navigate(`/teams/${t.id}`)}
                    className="text-left p-4 rounded-xl border border-accent-red/30 bg-accent-red/5 hover:bg-accent-red/10 transition-all"
                  >
                    <p className="text-sm font-semibold text-text-primary">{t.name}</p>
                    <p className="text-xs font-mono text-accent-red mt-1">{t.role}</p>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-xs font-mono text-text-muted tracking-wider mb-3">所有公开团队</h2>
            {teams.length === 0 ? (
              <div className="px-4 py-8 rounded-lg border border-border-subtle text-center text-sm text-text-muted font-mono">
                还没有公开团队 — 创建第一个吧
              </div>
            ) : (
              <div className="grid gap-3 grid-cols-1 md:grid-cols-2">
                {teams.map((t) => {
                  const isMember = myTeamIds.has(t.id)
                  return (
                    <div key={t.id} className="p-4 rounded-xl border border-border-subtle bg-bg-card hover:bg-bg-card-hover transition-all">
                      <button onClick={() => navigate(`/teams/${t.id}`)} className="block w-full text-left">
                        <p className="text-sm font-semibold text-text-primary">{t.name}</p>
                        {t.description && (
                          <p className="text-xs text-text-secondary mt-1 line-clamp-2">{t.description}</p>
                        )}
                        <p className="text-xs font-mono text-text-muted mt-2">
                          {t.member_count ?? 0} 名成员
                        </p>
                      </button>
                      <div className="mt-3">
                        {isMember ? (
                          <span className="text-xs font-mono text-accent-red">已加入</span>
                        ) : (
                          <button
                            onClick={() => handleJoin(t.id)}
                            disabled={joining === t.id}
                            className="text-xs font-medium px-3 py-1.5 rounded border border-accent-red/40 text-accent-red hover:bg-accent-red/10 disabled:opacity-50"
                          >
                            {joining === t.id ? '加入中...' : '加入'}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
