import { useState, type FormEvent } from 'react'
import { useNavigate, Link, Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

const AUTH_BASE = import.meta.env.VITE_AUTH_BASE_URL || ''
const CLIENT_ID = import.meta.env.VITE_AUTH_CLIENT_ID || ''

export default function RegisterPage() {
  const { isAuthenticated, registerSuccess } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (isAuthenticated) return <Navigate to="/" replace />

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (password !== passwordConfirm) {
      setError('两次输入的密码不一致')
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`${AUTH_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
        body: JSON.stringify({
          email,
          password,
          invite_code: inviteCode,
          name: email.split('@')[0],
        }),
      })

      if (res.status === 201) {
        const { access_token, refresh_token } = await res.json()
        registerSuccess(access_token, refresh_token)
        navigate('/onboarding')
        return
      }

      const data = await res.json().catch(() => ({}))
      if (res.status === 400) {
        setError('缺少必填字段')
      } else if (res.status === 401) {
        setError('邀请码无效')
      } else if (res.status === 409) {
        const msg: string = data.error || data.message || ''
        if (msg.toLowerCase().includes('invite') || msg.toLowerCase().includes('code')) {
          setError('邀请码已被使用')
        } else {
          setError('该邮箱已注册')
        }
      } else {
        setError(data.error || data.message || '注册失败，请重试')
      }
    } catch {
      setError('网络错误，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm">
        <div className="bg-bg-card border border-border-subtle rounded-2xl p-8">
          <h1 className="text-center text-xl font-bold text-text-primary tracking-tight mb-1">STRIDE</h1>
          <p className="text-center text-sm text-text-muted mb-6">创建账号</p>

          {error && (
            <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">邮箱</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">密码</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">确认密码</label>
              <input
                type="password"
                required
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">邀请码</label>
              <input
                type="text"
                required
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green font-mono"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading ? '注册中...' : '创建账号'}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-text-muted">
            已有账号？{' '}
            <Link to="/login" className="text-accent-green hover:underline">
              登录
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
