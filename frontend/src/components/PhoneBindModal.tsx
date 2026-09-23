import { useEffect, useState, type FormEvent } from "react";
import { bindPhone } from "../api";
import { useAuthStore } from "../store/authStore";

// Client-side pre-checks mirror the mini-program / login form's rules (11-digit
// mainland phone, 6-digit code). They save a doomed round-trip; the server
// still owns the real validation. The phone pattern matches the auth backend's
// `phoneNumberRe` (`^1[3-9]\d{9}$`).
const PHONE_RE = /^1[3-9]\d{9}$/;
const CODE_RE = /^\d{6}$/;

// Aligned with the backend's sms/send cooldown window.
const CODE_RESEND_SECONDS = 60;

interface AuthError {
  status?: number;
  error?: string;
}

// auth-service apperror codes → user-facing copy (phone bind surface).
const PHONE_ERROR_MESSAGES: Record<string, string> = {
  sms_code_invalid: "验证码错误",
  sms_code_expired: "验证码已过期,请重新获取",
  sms_attempts_exceeded: "尝试次数过多,请重新获取验证码",
  sms_send_cooldown: "发送过于频繁,请稍后再试",
  sms_daily_limit: "今日验证码次数已达上限",
  sms_not_configured: "短信服务未配置,请稍后再试",
  phone_already_bound: "该手机号已被其他账号绑定",
  user_disabled: "账号已被禁用",
};

function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}

// One form for both the bind (no phone yet) and rebind (replace the current
// phone) flows. The code is issued by POST /api/auth/sms/send with
// login_only=false so any mainland phone can receive one; bindPhone() (Bearer)
// consumes it. Used by the post-login PhoneBindPrompt gate (secondaryLabel
// "稍后再说") and by the settings page ("取消").
export default function PhoneBindModal({
  open,
  currentPhone,
  onClose,
  onBound,
  secondaryLabel = "稍后再说",
}: {
  open: boolean;
  currentPhone?: string | null;
  onClose: () => void;
  onBound?: () => void;
  secondaryLabel?: string;
}) {
  const { sendSmsCode } = useAuthStore();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isRebind = typeof currentPhone === "string" && currentPhone.length > 0;

  // Reset the form each time the modal opens.
  useEffect(() => {
    if (open) {
      setPhone("");
      setCode("");
      setCountdown(0);
      setError("");
    }
  }, [open]);

  // ESC closes the modal.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // One timer per remaining second; the cleanup stops it when the modal closes.
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  if (!open) return null;

  async function handleSendCode() {
    if (countdown > 0 || sendingCode) return;
    setError("");
    if (!PHONE_RE.test(phone)) {
      setError("请输入正确的手机号");
      return;
    }
    setSendingCode(true);
    try {
      // The phone-bind endpoint consumes only bind_phone-scene codes (ADR 0010).
      await sendSmsCode(phone, { loginOnly: false, scene: "bind_phone" });
      setCountdown(CODE_RESEND_SECONDS);
    } catch (err: unknown) {
      const x = err as AuthError;
      setError(PHONE_ERROR_MESSAGES[x.error ?? ""] ?? "验证码发送失败,请重试");
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
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
      const result = await bindPhone(phone, code);
      if (!result.ok) {
        const x = result.data as { error?: string };
        setError(PHONE_ERROR_MESSAGES[x.error ?? ""] ?? "绑定失败,请重试");
        return;
      }
      onBound?.();
      onClose();
    } catch {
      setError("网络错误,请重试");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isRebind ? "更换手机号" : "绑定手机号"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-bg-card border border-border rounded-2xl w-full max-w-sm p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{isRebind ? "更换手机号" : "绑定手机号"}</h2>
            <p className="text-xs font-mono text-text-muted mt-0.5">
              {isRebind ? `当前手机号 ${maskPhone(currentPhone as string)}` : "绑定后即可用手机号登录"}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="text-text-muted hover:text-text-primary text-lg leading-none">
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div>
            <label htmlFor="phone-bind-phone" className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              手机号
            </label>
            <input
              id="phone-bind-phone"
              type="tel"
              inputMode="numeric"
              dir="ltr"
              placeholder="138 0000 0000"
              autoComplete="tel"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="phone-bind-code" className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
              验证码
            </label>
            <div className="flex gap-2">
              <input
                id="phone-bind-code"
                type="text"
                inputMode="numeric"
                dir="ltr"
                placeholder="6 位数字"
                autoComplete="one-time-code"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={inputCls}
              />
              <button
                type="button"
                onClick={handleSendCode}
                disabled={countdown > 0 || sendingCode}
                className="shrink-0 rounded-lg border border-accent-green/40 px-3 py-2 text-sm text-accent-green hover:bg-accent-green/10 disabled:opacity-50 transition-colors"
              >
                {sendingCode ? "发送中…" : countdown > 0 ? `重新获取(${countdown}s)` : "获取验证码"}
              </button>
            </div>
          </div>

          {error && <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">{error}</div>}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-border-subtle px-4 py-2 text-sm text-text-muted hover:text-text-primary transition-colors">
              {secondaryLabel}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 rounded-lg bg-accent-green/90 px-4 py-2 text-sm font-medium text-bg-base hover:bg-accent-green disabled:opacity-50 transition-colors"
            >
              {loading ? "提交中…" : isRebind ? "更换手机号" : "绑定"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
