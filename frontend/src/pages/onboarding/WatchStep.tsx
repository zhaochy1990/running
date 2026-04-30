import { useState, type FormEvent } from 'react'
import { postCorosLogin, postGarminLogin } from '../../api'

type Provider = 'coros' | 'garmin'
type Region = 'cn' | 'global'

interface Props {
  onSuccess: () => void
}

interface ProviderMeta {
  id: Provider
  display_name: string
  caption: string
  accent_classes: string  // tailwind classes for the accent border/text
  description: string
  needs_region: boolean
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'coros',
    display_name: 'COROS',
    caption: '高驰',
    accent_classes:
      'border-accent-green/40 bg-accent-green/5 hover:border-accent-green hover:bg-accent-green/10',
    description: '同步活动、健康指标、训练负荷；支持训练计划推送至手表',
    needs_region: false,
  },
  {
    id: 'garmin',
    display_name: 'GARMIN',
    caption: '佳明',
    accent_classes:
      'border-sky-500/40 bg-sky-500/5 hover:border-sky-500 hover:bg-sky-500/10',
    description: '同步活动、跑姿、HRV、训练负荷；目前仅支持只读',
    needs_region: true,
  },
]


export default function WatchStep({ onSuccess }: Props) {
  const [provider, setProvider] = useState<Provider | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [region, setRegion] = useState<Region>('cn')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const meta = provider ? PROVIDERS.find((p) => p.id === provider)! : null

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!provider) return
    setError('')
    setLoading(true)
    try {
      const result =
        provider === 'coros'
          ? await postCorosLogin(email, password)
          : await postGarminLogin(email, password, region)
      if (result.ok) {
        onSuccess()
      } else {
        const msg = (result.data as { error?: string; detail?: unknown }).error
        const fallback =
          provider === 'coros'
            ? 'COROS 账号验证失败，请检查邮箱和密码'
            : '佳明账号验证失败，请检查邮箱、密码和区域'
        setError(msg || fallback)
      }
    } catch {
      setError('请求失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  // Picker view ────────────────────────────────────────────────────────────
  if (!provider) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-bold text-text-primary">选择你的手表</h2>
          <p className="text-sm text-text-muted mt-1">
            选择你日常使用的运动手表，用于同步训练数据
          </p>
        </div>

        <div className="space-y-3">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setProvider(p.id)
                setError('')
              }}
              className={`w-full text-left rounded-xl border-2 px-4 py-4 transition-all cursor-pointer ${p.accent_classes}`}
            >
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-base font-bold text-text-primary tracking-wide">
                  {p.display_name}
                </span>
                <span className="text-sm text-text-muted">{p.caption}</span>
              </div>
              <p className="mt-1 text-xs text-text-muted leading-relaxed">{p.description}</p>
            </button>
          ))}
        </div>
      </div>
    )
  }

  // Login form view ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          onClick={() => {
            setProvider(null)
            setError('')
            setEmail('')
            setPassword('')
          }}
          className="text-xs font-mono text-text-muted hover:text-text-primary transition-colors cursor-pointer mb-2"
        >
          ← 重新选择手表
        </button>
        <h2 className="text-lg font-bold text-text-primary">
          连接 {meta!.display_name} 账号
        </h2>
        <p className="text-sm text-text-muted mt-1">
          输入你的 {meta!.caption} 账号用于同步训练数据
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
            {meta!.caption} 邮箱
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
        </div>
        <div>
          <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
            {meta!.caption} 密码
          </label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
          />
        </div>

        {meta!.needs_region && (
          <div>
            <label className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              账号区域
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(['cn', 'global'] as Region[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRegion(r)}
                  className={`rounded-lg px-3 py-2 text-sm border transition-colors cursor-pointer ${
                    region === r
                      ? 'border-accent-green bg-accent-green/10 text-text-primary'
                      : 'border-border-subtle bg-bg-base text-text-muted hover:border-border-strong'
                  }`}
                >
                  {r === 'cn' ? '中国 (garmin.cn)' : '国际 (garmin.com)'}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-text-muted">
              如果你常在 connect.garmin.cn 登录，选"中国"；otherwise 选"国际"。
            </p>
          </div>
        )}

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
