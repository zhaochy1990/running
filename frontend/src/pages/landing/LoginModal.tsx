import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuthStore } from '../../store/authStore'

export default function LoginModal({ onClose }: { onClose: () => void }) {
  const { login } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      navigate('/')
    } catch (err: unknown) {
      const x = err as { status?: number; error?: string }
      if (x.status === 401) setError('邮箱或密码错误')
      else if (x.error === 'user_disabled') setError('账号已被禁用')
      else setError('登录失败,请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="login-overlay"
      id="loginOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="登录 STRIDE"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="lg-modal">
        <button className="lg-close" type="button" aria-label="关闭" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>

        {/* left — brand / energy pane */}
        <aside className="lg-brandpane">
          <div className="lg-bp-top">
            <div className="lg-mark">S</div>
            <div>
              <div className="lg-bp-name">STRIDE</div>
              <div className="lg-bp-sub">训练中心</div>
            </div>
          </div>

          <div className="lg-bp-mid">
            <div className="lg-bp-eyebrow">EVERY STRIDE, MEASURED</div>
            <p className="lg-bp-quote">
              每一步都<em>有数据</em>,<br />
              每一份计划都<em>属于你</em>。
            </p>

            <div className="lg-bp-route">
              <svg viewBox="0 0 520 120" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="lgrg" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#0097a7" />
                    <stop offset="1" stopColor="#3ee08a" />
                  </linearGradient>
                </defs>
                <path
                  className="lg-route-line"
                  d="M0,92 C60,92 78,40 130,40 C180,40 196,86 250,86 C300,86 320,22 372,30 C420,38 440,70 520,58"
                />
                <circle className="lg-route-dot" cx="520" cy="58" r="5" />
              </svg>
            </div>

            <div className="lg-bp-stats">
              <div className="s">
                <div className="v">42.2<span className="u">km</span></div>
                <div className="l">最近长距</div>
              </div>
              <div className="s">
                <div className="v">4'38"<span className="u">/km</span></div>
                <div className="l">平均配速</div>
              </div>
              <div className="s">
                <div className="v">26<span className="u">周</span></div>
                <div className="l">当前周期</div>
              </div>
            </div>
          </div>

          <div className="lg-bp-foot">
            <span>STRIDE © 2026</span>
            <span>BUILT FOR RUNNERS</span>
          </div>
        </aside>

        {/* right — form pane */}
        <main className="lg-formpane">
          <div className="lg-card">
            <div className="lg-form-eyebrow">欢迎回来</div>
            <h2 className="lg-h">登录 STRIDE</h2>
            <p className="lg-sub">继续你的训练周期,查看本周计划与教练建议。</p>

            {/* OAuth buttons and divider intentionally omitted */}

            <form onSubmit={handleSubmit}>
              <div className="lg-field">
                <label htmlFor="lgEmail">邮箱</label>
                <input
                  id="lgEmail"
                  type="email"
                  dir="ltr"
                  placeholder="you@runner.com"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="lg-field">
                <div className="lg-row">
                  <label htmlFor="lgPw">密码</label>
                  {/* 忘记密码链接 intentionally omitted */}
                </div>
                <input
                  id="lgPw"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {error && <div className="lg-error">{error}</div>}

              <button className="lg-submit" type="submit" disabled={loading}>
                {loading ? '登录中…' : '登录'}
                {!loading && (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                )}
              </button>
            </form>

            <p className="lg-swap">
              还没有账号? <Link to="/register">创建训练档案 →</Link>
            </p>
            <p className="lg-legal">
              登录即代表你同意 <a href="#">服务条款</a> 与 <a href="#">隐私政策</a>。
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}
