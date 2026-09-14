import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";

// Client-side pre-checks mirror the mini-program's rules (11-digit mainland
// phone, 6-digit code). They save a doomed round-trip; the server still owns
// the real validation. The phone pattern matches the auth backend's
// `phoneNumberRe` (`^1[3-9]\d{9}$`) so a locally-valid number is never the
// reason a request comes back as a generic bad_request.
const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{6}$/;

// Aligned with the backend's sms/send cooldown window.
const CODE_RESEND_SECONDS = 60;

type LoginTab = "email" | "phone";

interface AuthError {
  status?: number;
  error?: string;
}

// auth-service apperror codes → user-facing copy.
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  sms_code_invalid: "验证码错误",
  sms_code_expired: "验证码已过期,请重新获取",
  sms_attempts_exceeded: "尝试次数过多,请重新获取验证码",
  sms_send_cooldown: "发送过于频繁,请稍后再试",
  sms_daily_limit: "今日验证码次数已达上限",
  sms_not_configured: "短信服务未配置,请使用邮箱登录",
  service_unavailable: "服务暂时不可用,请稍后再试",
  invalid_invite_code: "邀请码无效",
  invite_code_already_used: "邀请码已被使用",
  user_disabled: "账号已被禁用",
};

export default function LoginModal({ onClose }: { onClose: () => void }) {
  const { login, sendSmsCode, loginWithPhone } = useAuthStore();
  const navigate = useNavigate();
  const [tab, setTab] = useState<LoginTab>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteRequired, setInviteRequired] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // One timer per remaining second; the cleanup stops it when the modal closes.
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  function switchTab(next: LoginTab) {
    if (next === tab) return;
    setTab(next);
    setError("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err: unknown) {
      const x = err as AuthError;
      if (x.status === 401) setError("邮箱或密码错误");
      else setError(AUTH_ERROR_MESSAGES[x.error ?? ""] ?? "登录失败,请重试");
    } finally {
      setLoading(false);
    }
  }

  async function handleSendCode() {
    if (countdown > 0 || sendingCode) return;
    setError("");
    if (!PHONE_RE.test(phone)) {
      setError("请输入正确的手机号");
      return;
    }
    setSendingCode(true);
    try {
      await sendSmsCode(phone);
      setCountdown(CODE_RESEND_SECONDS);
    } catch (err: unknown) {
      const x = err as AuthError;
      setError(AUTH_ERROR_MESSAGES[x.error ?? ""] ?? "验证码发送失败,请重试");
    } finally {
      setSendingCode(false);
    }
  }

  async function handlePhoneSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!PHONE_RE.test(phone)) {
      setError("请输入正确的手机号");
      return;
    }
    if (!CODE_RE.test(code)) {
      setError("请输入 6 位验证码");
      return;
    }
    setLoading(true);
    try {
      await loginWithPhone(phone, code, inviteCode);
      navigate("/");
    } catch (err: unknown) {
      setPhoneError(err as AuthError);
    } finally {
      setLoading(false);
    }
  }

  function setPhoneError(x: AuthError) {
    // Invalid or already-used invites keep the field open so the user can fix
    // it. A brand-new phone under an invite-gated deployment is rejected with a
    // generic bad_request ("invite_code is required") *before* the SMS code is
    // consumed — that is the backend's "new phone, needs an invite" signal.
    if (x.error === "invalid_invite_code" || x.error === "invite_code_already_used" || x.error === "bad_request") {
      setInviteRequired(true);
      setError(x.error === "bad_request" ? "请输入邀请码" : AUTH_ERROR_MESSAGES[x.error]);
      return;
    }
    setError(AUTH_ERROR_MESSAGES[x.error ?? ""] ?? "登录失败,请重试");
  }

  const submitButton = (
    <button className="lg-submit" type="submit" disabled={loading}>
      {loading ? "登录中…" : "登录"}
      {!loading && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      )}
    </button>
  );

  return (
    <div
      className="login-overlay open"
      id="loginOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="登录 STRIDE"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
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
            <div className="lg-bp-eyebrow">EVERY STRIDE, MEASURED · EVERY PLAN, YOURS</div>
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
                <path className="lg-route-line" d="M0,92 C60,92 78,40 130,40 C180,40 196,86 250,86 C300,86 320,22 372,30 C420,38 440,70 520,58" />
                <circle className="lg-route-dot" cx="520" cy="58" r="5" />
              </svg>
            </div>

            <div className="lg-bp-stats">
              <div className="s">
                <div className="v">
                  42.2<span className="u">km</span>
                </div>
                <div className="l">最近长距</div>
              </div>
              <div className="s">
                <div className="v">
                  4'38"<span className="u">/km</span>
                </div>
                <div className="l">平均配速</div>
              </div>
              <div className="s">
                <div className="v">
                  26<span className="u">周</span>
                </div>
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

            <div className="lg-tabs">
              <button type="button" aria-pressed={tab === "email"} className={tab === "email" ? "lg-tab active" : "lg-tab"} onClick={() => switchTab("email")}>
                邮箱
              </button>
              <button type="button" aria-pressed={tab === "phone"} className={tab === "phone" ? "lg-tab active" : "lg-tab"} onClick={() => switchTab("phone")}>
                手机号
              </button>
            </div>

            {tab === "email" ? (
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

                {submitButton}
              </form>
            ) : (
              <form onSubmit={handlePhoneSubmit}>
                <div className="lg-field">
                  <label htmlFor="lgPhone">手机号</label>
                  <input
                    id="lgPhone"
                    type="tel"
                    inputMode="numeric"
                    dir="ltr"
                    placeholder="138 0000 0000"
                    autoComplete="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <div className="lg-field">
                  <label htmlFor="lgCode">验证码</label>
                  <div className="lg-code-row">
                    <input
                      id="lgCode"
                      type="text"
                      inputMode="numeric"
                      dir="ltr"
                      placeholder="6 位数字"
                      autoComplete="one-time-code"
                      maxLength={6}
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                    <button type="button" className="lg-code-btn" onClick={handleSendCode} disabled={countdown > 0 || sendingCode}>
                      {sendingCode ? "发送中…" : countdown > 0 ? `重新获取(${countdown}s)` : "获取验证码"}
                    </button>
                  </div>
                </div>

                {inviteRequired && (
                  <div className="lg-field">
                    <label htmlFor="lgInvite">邀请码</label>
                    <input
                      id="lgInvite"
                      type="text"
                      dir="ltr"
                      placeholder="请输入邀请码"
                      autoComplete="off"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                    />
                  </div>
                )}

                {error && <div className="lg-error">{error}</div>}

                {submitButton}
              </form>
            )}

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
  );
}
