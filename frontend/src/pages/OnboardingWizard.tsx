import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { getMyProfile, type ProfileIn, type RunningAgeRange } from '../api'
import InjuryStep from './onboarding/InjuryStep'
import { useAuthStore } from '../store/authStore'
import ProfileStep from './onboarding/ProfileStep'
import SubmitStep from './onboarding/SubmitStep'
import WatchStep from './onboarding/WatchStep'

type Step = 'loading' | 'profile' | 'watch' | 'injuries' | 'submit' | 'done'

function reconstructProfile(p: Record<string, unknown> | null): ProfileIn | null {
  if (!p) return null
  // Profile onboarding owns only the Go profile fields; race goals are set later.
  const required = ['display_name', 'dob', 'sex', 'height_cm', 'weight_kg', 'running_age_range']
  for (const k of required) {
    if (p[k] === undefined || p[k] === null) return null
  }
  return {
    display_name: String(p.display_name),
    dob: String(p.dob),
    sex: String(p.sex),
    height_cm: Number(p.height_cm),
    weight_kg: Number(p.weight_kg),
    running_age_range: (String(p.running_age_range) as RunningAgeRange),
  }
}

export default function OnboardingWizard() {
  const [step, setStep] = useState<Step>('loading')
  const [profileData, setProfileData] = useState<ProfileIn | null>(null)
  const userId = useAuthStore((s) => s.userId)
  const navigate = useNavigate()
  const logout = useAuthStore((s) => s.logout)
  const [signingOut, setSigningOut] = useState(false)

  // Escape hatch so a user can never get permanently stuck in onboarding —
  // logs out (clears the session) and returns to the login screen.
  const handleLogout = async () => {
    setSigningOut(true)
    try {
      await logout()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        if (p.onboarding.completed_at) {
          setStep('done')
          return
        }

        // Basic profile is the first prerequisite. A profile may have been
        // stored while an earlier watch connection failed, so reconstruct it
        // whenever possible and avoid asking for it twice.
        const reconstructed = reconstructProfile(p.profile)
        if (p.onboarding.profile_ready && reconstructed) {
          setProfileData(reconstructed)
        }
        if (!p.onboarding.profile_ready || !reconstructed) {
          setStep('profile')
        } else if (!(p.onboarding.watch_ready ?? p.onboarding.coros_ready)) {
          // Go uses watch_ready; Python retains the legacy coros_ready name.
          setStep('watch')
        } else {
          setStep('injuries')
        }
      })
      .catch(() => {
        // Profile not yet created — start from the first prerequisite.
        setStep('profile')
      })
  }, [])

  if (step === 'done') return <Navigate to="/" replace />

  const stepIndex = step === 'profile' ? 0 : step === 'watch' ? 1 : step === 'injuries' ? 2 : step === 'submit' ? 3 : -1
  const steps = ['基础资料', '绑定手表', '伤病记录（可跳过）', '同步数据']

  return (
    <div className="flex min-h-screen items-start justify-center bg-bg-base px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold text-text-primary tracking-tight">STRIDE 初始化</h1>
          <p className="text-sm text-text-muted mt-1">完成设置以开始使用你的训练仪表盘</p>
          <button
            type="button"
            onClick={handleLogout}
            disabled={signingOut}
            data-testid="onboarding-logout"
            className="mt-3 text-xs text-text-muted underline underline-offset-2 hover:text-text-primary disabled:opacity-50 transition-colors cursor-pointer"
          >
            {signingOut ? '登出中...' : '登出 / 切换账号'}
          </button>
        </div>

        {stepIndex >= 0 && (
          <ol className="mb-8 grid grid-cols-3 gap-2" aria-label="初始化步骤">
            {steps.map((label, index) => {
              const state = index < stepIndex ? '已完成' : index === stepIndex ? '进行中' : '未开始'
              return (
                <li key={label} className="flex min-w-0 items-center gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium ${
                      index < stepIndex
                        ? 'border-accent-green bg-accent-green text-bg-base'
                        : index === stepIndex
                          ? 'border-accent-green text-accent-green'
                          : 'border-border-subtle text-text-muted'
                    }`}
                  >
                    {index < stepIndex ? '✓' : index + 1}
                  </span>
                  <span className={index === stepIndex ? 'font-medium text-text-primary' : 'text-text-muted'}>
                    {label}
                  </span>
                  <span className="sr-only">：{state}</span>
                </li>
              )
            })}
          </ol>
        )}

        <div className="bg-bg-card border border-border-subtle rounded-lg p-8">
          {step === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
            </div>
          )}

          {step === 'profile' && (
            <ProfileStep
              onSuccess={(p) => {
                setProfileData(p)
                setStep('watch')
              }}
            />
          )}

          {step === 'watch' && (
            <WatchStep onSuccess={() => setStep('injuries')} />
          )}

          {step === 'injuries' && (
            <InjuryStep onSuccess={() => setStep('submit')} />
          )}

          {step === 'submit' && profileData && userId && (
            <SubmitStep userId={userId} />
          )}

          {step === 'submit' && !profileData && (
            <div className="text-center py-8 text-text-muted text-sm">
              <p>加载中...</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
