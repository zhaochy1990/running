import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  disconnectWatch,
  getWatchInfo,
  postCorosLogin,
  postGarminLogin,
  type WatchInfo,
} from '../api'

type ConnectProvider = 'coros' | 'garmin' | null

interface WatchPageProps {
  embedded?: boolean
}

export default function WatchPage({ embedded }: WatchPageProps = {}) {
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [watch, setWatch] = useState<WatchInfo | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Disconnect state
  const [disconnecting, setDisconnecting] = useState(false)
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false)

  // Connect state
  const [connectProvider, setConnectProvider] = useState<ConnectProvider>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [region, setRegion] = useState<'cn' | 'global'>('cn')
  const [connecting, setConnecting] = useState(false)

  const fetchWatch = () => {
    setLoading(true)
    getWatchInfo()
      .then((info) => {
        setWatch(info)
        setError('')
      })
      .catch(() => setError('加载手表信息失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchWatch()
  }, [])

  const handleDisconnect = async () => {
    setDisconnecting(true)
    setError('')
    try {
      const res = await disconnectWatch()
      if (res.ok) {
        setSuccess('已解除绑定')
        setShowDisconnectConfirm(false)
        fetchWatch()
        setTimeout(() => setSuccess(''), 3000)
      } else {
        setError((res.data as { detail?: string }).detail || '解除绑定失败')
      }
    } catch {
      setError('请求失败，请重试')
    } finally {
      setDisconnecting(false)
    }
  }

  const handleConnect = async () => {
    if (connecting || !email.trim() || !password.trim() || !connectProvider) return
    setConnecting(true)
    setError('')
    try {
      const res = connectProvider === 'garmin'
        ? await postGarminLogin(email.trim(), password.trim(), region)
        : await postCorosLogin(email.trim(), password.trim())
      if (res.ok) {
        setSuccess('绑定成功')
        setConnectProvider(null)
        setEmail('')
        setPassword('')
        fetchWatch()
        setTimeout(() => setSuccess(''), 3000)
      } else {
        const detail = res.data?.detail
        setError(typeof detail === 'string' ? detail : '登录失败，请检查账号密码')
      }
    } catch {
      setError('请求失败，请重试')
    } finally {
      setConnecting(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-border-subtle px-3 py-2 text-sm text-text-primary bg-bg-base focus:outline-none focus:ring-1 focus:ring-accent-green focus:border-accent-green'

  if (loading) {
    return (
      <div className={embedded ? 'py-10 flex items-center justify-center' : 'max-w-3xl mx-auto px-8 py-20 flex items-center justify-center'}>
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  const isConnected = watch?.logged_in

  return (
    <div className={embedded ? '' : 'max-w-3xl mx-auto px-4 py-6 sm:px-8 sm:py-8'}>
      {!embedded && (
        <>
          <button
            onClick={() => navigate(-1)}
            className="text-xs font-mono text-text-muted hover:text-text-secondary mb-4"
          >
            &larr; 返回
          </button>

          <div className="mb-8">
            <h1 className="text-2xl font-bold text-text-primary">手表管理</h1>
            <p className="text-sm font-mono text-text-muted mt-1">
              管理你的运动手表绑定
            </p>
          </div>
        </>
      )}

      {error && (
        <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 rounded-lg bg-accent-green/10 border border-accent-green/30 px-3 py-2 text-sm text-accent-green">
          {success}
        </div>
      )}

      {/* Current watch info */}
      <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 mb-6">
        <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-2 mb-4">
          当前绑定
        </h3>

        {isConnected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent-green/10 flex items-center justify-center text-accent-green font-bold text-sm">
                {watch.provider_display_name?.charAt(0) || '?'}
              </div>
              <div>
                <div className="text-sm font-semibold text-text-primary">
                  {watch.provider_display_name || watch.provider}
                </div>
                <div className="text-xs font-mono text-text-muted">
                  {watch.email || '—'}
                </div>
              </div>
              <span className="ml-auto inline-flex items-center gap-1 text-xs font-mono text-accent-green">
                <span className="w-1.5 h-1.5 rounded-full bg-accent-green" />
                已连接
              </span>
            </div>

            {watch.device && (
              <div className="flex justify-between text-sm">
                <span className="text-text-muted font-mono">设备型号</span>
                <span className="text-text-primary font-mono">{watch.device}</span>
              </div>
            )}

            {watch.last_sync_at && (
              <div className="flex justify-between text-sm">
                <span className="text-text-muted font-mono">最后同步</span>
                <span className="text-text-primary font-mono">{watch.last_sync_at}</span>
              </div>
            )}

            {watch.capabilities && watch.capabilities.length > 0 && (
              <div className="pt-2 border-t border-border-subtle">
                <span className="text-xs font-mono text-text-muted">支持功能</span>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {watch.capabilities.map((cap) => (
                    <span
                      key={cap}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-base border border-border-subtle text-text-muted"
                    >
                      {cap.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-6">
            <div className="text-4xl mb-2 opacity-30">&#x231A;</div>
            <p className="text-sm text-text-muted font-mono">
              未绑定手表
            </p>
            <p className="text-xs text-text-muted font-mono mt-1">
              绑定手表后可同步训练数据
            </p>
          </div>
        )}
      </section>

      {/* Actions */}
      {isConnected ? (
        <section className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5">
          <h3 className="text-sm font-semibold text-red-400 mb-2">解除绑定</h3>
          <p className="text-xs text-text-muted mb-3">
            解除绑定将清除手表登录凭据。已同步的训练数据不会被删除，但无法再同步新数据。
          </p>

          {showDisconnectConfirm ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {disconnecting ? '解除中...' : '确认解除'}
              </button>
              <button
                onClick={() => setShowDisconnectConfirm(false)}
                disabled={disconnecting}
                className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-base"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowDisconnectConfirm(true)}
              className="rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10"
            >
              解除绑定
            </button>
          )}
        </section>
      ) : (
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5">
          <h3 className="text-xs font-mono text-text-muted uppercase tracking-wider border-b border-border-subtle pb-2 mb-4">
            绑定手表
          </h3>

          {connectProvider === null ? (
            <div className="flex gap-3">
              <button
                onClick={() => setConnectProvider('coros')}
                className="flex-1 rounded-xl border border-border-subtle p-4 hover:border-accent-green/50 hover:bg-accent-green/5 transition-colors text-center"
              >
                <div className="text-lg font-bold text-text-primary mb-1">COROS</div>
                <div className="text-xs font-mono text-text-muted">高驰</div>
              </button>
              <button
                onClick={() => setConnectProvider('garmin')}
                className="flex-1 rounded-xl border border-border-subtle p-4 hover:border-accent-green/50 hover:bg-accent-green/5 transition-colors text-center"
              >
                <div className="text-lg font-bold text-text-primary mb-1">Garmin</div>
                <div className="text-xs font-mono text-text-muted">佳明</div>
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-text-primary">
                  {connectProvider === 'coros' ? 'COROS 高驰' : 'Garmin 佳明'}
                </span>
                <button
                  onClick={() => {
                    setConnectProvider(null)
                    setError('')
                  }}
                  className="text-xs font-mono text-text-muted hover:text-text-secondary"
                >
                  换一个
                </button>
              </div>

              <input
                type="text"
                inputMode="email"
                autoComplete="username"
                placeholder={connectProvider === 'coros' ? '邮箱或手机号' : '邮箱'}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputCls}
              />
              <input
                type="password"
                placeholder="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
              />

              {connectProvider === 'garmin' && (
                <select
                  value={region}
                  onChange={(e) => setRegion(e.target.value as 'cn' | 'global')}
                  className={inputCls}
                >
                  <option value="cn">中国区 (connect.garmin.cn)</option>
                  <option value="global">国际区 (connect.garmin.com)</option>
                </select>
              )}

              <button
                onClick={handleConnect}
                disabled={connecting || !email.trim() || !password.trim()}
                className="w-full rounded-lg bg-accent-green px-4 py-2.5 text-sm font-medium text-bg-base hover:bg-accent-green/90 disabled:opacity-50"
              >
                {connecting ? '连接中...' : '绑定'}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
