import { useState, type FormEvent } from 'react'
import { useNavigate, Link, Navigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

const AUTH_BASE = import.meta.env.VITE_AUTH_BASE_URL || ''
const CLIENT_ID = import.meta.env.VITE_AUTH_CLIENT_ID || ''

interface PasswordRule {
  id: string
  label: string
  isValid: boolean
}

function extractErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractErrorMessage(item)
      if (message) return message
    }
    return ''
  }
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>
    return (
      extractErrorMessage(data.error) ||
      extractErrorMessage(data.message) ||
      extractErrorMessage(data.detail) ||
      extractErrorMessage(data.msg)
    )
  }
  return ''
}

function translateRegisterError(message: string): string {
  const normalized = message.toLowerCase()
  if (!normalized.includes('password')) return message

  if (normalized.includes('uppercase')) return '密码必须包含至少一个大写字母'
  if (normalized.includes('lowercase')) return '密码必须包含至少一个小写字母'
  if (normalized.includes('digit') || normalized.includes('number')) return '密码必须包含至少一个数字'
  if (normalized.includes('special')) return '密码必须包含至少一个特殊字符'
  if (normalized.includes('128') || normalized.includes('exceed') || normalized.includes('long')) {
    return '密码长度不能超过 128 位'
  }
  if (normalized.includes('8') || normalized.includes('length') || normalized.includes('short')) {
    return '密码长度至少为 8 位'
  }

  return '密码不符合规则，请按要求设置后重试'
}

function registerErrorMessage(status: number, data: unknown): string {
  const serverMessage = extractErrorMessage(data)

  if (status === 400) {
    return serverMessage ? translateRegisterError(serverMessage) : '请填写邮箱、密码和邀请码'
  }

  if (status === 401) return '邀请码无效'

  if (status === 409) {
    const msg = serverMessage.toLowerCase()
    return msg.includes('invite') || msg.includes('code') ? '邀请码已被使用' : '该邮箱已注册'
  }

  return serverMessage || '注册失败，请重试'
}

function isUppercaseLetter(char: string): boolean {
  return char.toLocaleUpperCase() === char && char.toLocaleLowerCase() !== char
}

function isLowercaseLetter(char: string): boolean {
  return char.toLocaleLowerCase() === char && char.toLocaleUpperCase() !== char
}

function isAlphanumeric(char: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(char)
}

function getPasswordRules(password: string): PasswordRule[] {
  const chars = Array.from(password)
  const byteLength = new TextEncoder().encode(password).length

  return [
    { id: 'min-length', label: '至少 8 个字符', isValid: byteLength >= 8 },
    { id: 'max-length', label: '不超过 128 个字符', isValid: byteLength <= 128 },
    { id: 'uppercase', label: '包含至少一个大写字母', isValid: chars.some(isUppercaseLetter) },
    { id: 'lowercase', label: '包含至少一个小写字母', isValid: chars.some(isLowercaseLetter) },
    { id: 'digit', label: '包含至少一个数字', isValid: /[0-9]/.test(password) },
    { id: 'special', label: '包含至少一个特殊字符', isValid: chars.some((char) => !isAlphanumeric(char)) },
  ]
}

function PasswordVisibilityIcon({ visible }: { visible: boolean }) {
  if (visible) {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 3l18 18" strokeLinecap="round" />
        <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" strokeLinecap="round" />
        <path d="M9.9 5.2A9.9 9.9 0 0 1 12 5c5.5 0 9 5.8 9 7a8.7 8.7 0 0 1-2.1 3" strokeLinecap="round" />
        <path d="M6.6 6.6C4.3 8.1 3 11 3 12c0 1.2 3.5 7 9 7a9.7 9.7 0 0 0 4.2-.9" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 12c0-1.2 3.5-7 9-7s9 5.8 9 7-3.5 7-9 7-9-5.8-9-7Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  visible: boolean
  invalid?: boolean
  describedBy?: string
  children?: React.ReactNode
  onChange: (value: string) => void
  onToggle: () => void
}

function PasswordField({ id, label, value, visible, invalid, describedBy, children, onChange, onToggle }: PasswordFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          required
          autoComplete="new-password"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 pr-11 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
        />
        <button
          type="button"
          aria-label={visible ? `隐藏${label}` : `显示${label}`}
          aria-pressed={visible}
          onClick={onToggle}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-muted hover:text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-green rounded-r-lg"
        >
          <PasswordVisibilityIcon visible={visible} />
        </button>
      </div>
      {children}
    </div>
  )
}

function PasswordRuleList({ id, rules, visible }: { id: string; rules: PasswordRule[]; visible: boolean }) {
  if (!visible) return null

  return (
    <ul id={id} className="mt-2 space-y-1 text-xs" aria-label="密码规则">
      {rules.map((rule) => (
        <li
          key={rule.id}
          className={rule.isValid ? 'flex items-center gap-1.5 text-accent-green' : 'flex items-center gap-1.5 text-red-400'}
        >
          <span aria-hidden="true">{rule.isValid ? '✓' : '○'}</span>
          <span>{rule.label}</span>
        </li>
      ))}
    </ul>
  )
}

export default function RegisterPage() {
  const { isAuthenticated, registerSuccess } = useAuthStore()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [passwordConfirmVisible, setPasswordConfirmVisible] = useState(false)
  const passwordRules = getPasswordRules(password)
  const passwordIsValid = passwordRules.every((rule) => rule.isValid)
  const showPasswordRules = password.length > 0

  if (isAuthenticated) return <Navigate to="/" replace />

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (password !== passwordConfirm) {
      setError('两次输入的密码不一致')
      return
    }

    const failedPasswordRule = getPasswordRules(password).find((rule) => !rule.isValid)
    if (failedPasswordRule) {
      setError(`密码不符合规则：${failedPasswordRule.label}`)
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
      setError(registerErrorMessage(res.status, data))
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
              <label htmlFor="register-email" className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                邮箱
              </label>
              <input
                id="register-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent-green focus:outline-none focus:ring-1 focus:ring-accent-green"
              />
            </div>
            <PasswordField
              id="register-password"
              label="密码"
              value={password}
              visible={passwordVisible}
              invalid={showPasswordRules && !passwordIsValid}
              describedBy={showPasswordRules ? 'register-password-rules' : undefined}
              onChange={setPassword}
              onToggle={() => setPasswordVisible((visible) => !visible)}
            >
              <PasswordRuleList id="register-password-rules" rules={passwordRules} visible={showPasswordRules} />
            </PasswordField>
            <PasswordField
              id="register-password-confirm"
              label="确认密码"
              value={passwordConfirm}
              visible={passwordConfirmVisible}
              onChange={setPasswordConfirm}
              onToggle={() => setPasswordConfirmVisible((visible) => !visible)}
            />
            <div>
              <label htmlFor="register-invite-code" className="block text-xs font-mono text-text-muted uppercase tracking-wider mb-1">
                邀请码
              </label>
              <input
                id="register-invite-code"
                type="text"
                required
                autoComplete="off"
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
