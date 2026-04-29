import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createTeam } from '../../api'

export default function CreateTeamPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('团队名称不能为空')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await createTeam({
        name: name.trim(),
        description: description.trim() || undefined,
      })
      if (!res.ok) throw new Error(`创建失败 (${res.status})`)
      navigate(`/teams/${res.data.id}`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:px-8 sm:py-8">
      <button onClick={() => navigate('/teams')} className="text-xs font-mono text-text-muted hover:text-text-secondary mb-4">← 返回</button>

      <h1 className="text-2xl font-bold text-text-primary mb-2">创建团队</h1>
      <p className="text-sm font-mono text-text-muted mb-8">创建后你将自动成为团队所有者，其他用户可以公开加入。</p>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-xs font-mono text-text-muted tracking-wider mb-2">
            名称 <span className="text-accent-red">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-bg-card text-sm text-text-primary focus:border-accent-red focus:outline-none"
            placeholder="例如：周末长跑团"
          />
        </div>

        <div>
          <label className="block text-xs font-mono text-text-muted tracking-wider mb-2">
            简介 (可选)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-bg-card text-sm text-text-primary focus:border-accent-red focus:outline-none resize-y"
            placeholder="一句话介绍这个团队"
          />
        </div>

        {error && (
          <div className="px-4 py-3 rounded-lg border border-accent-red/30 bg-accent-red/5 text-sm text-accent-red font-mono">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="px-5 py-2.5 text-sm font-medium rounded-lg border border-accent-red/40 text-accent-red hover:bg-accent-red/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {submitting ? '创建中...' : '创建团队'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/teams')}
            className="px-5 py-2.5 text-sm font-medium rounded-lg border border-border text-text-muted hover:bg-bg-card transition-all"
          >
            取消
          </button>
        </div>
      </form>
    </div>
  )
}
