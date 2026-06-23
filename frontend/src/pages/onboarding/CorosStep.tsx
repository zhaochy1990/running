import { useState, type FormEvent } from 'react'
import { postCorosLogin } from '../../api'

interface Props {
  onSuccess: () => void
}

export default function CorosStep({ onSuccess }: Props) {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { ok, data } = await postCorosLogin(account.trim(), password)
      if (ok) {
        onSuccess()
      } else {
        const msg = (data as { error?: string; detail?: unknown }).error
        setError(msg || 'COROS 账号验证失败，请检查账号和密码')
      }
    } catch {
      setError('请求失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">连接 COROS 账号</h2>
        <p className="text-sm text-text-muted mt-1">输入你的 COROS 账号（邮箱或手机号）用于同步训练数据</p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">COROS 账号</label>
          <input
            type="text"
            inputMode="email"
            autoComplete="username"
            placeholder="邮箱或手机号"
            required
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
        </div>
        <div>
          <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">COROS 密码</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer"
        >
          {loading ? '验证中...' : '连接账号'}
        </button>
      </form>
    </div>
  )
}
