import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { getMyProfile, type ProfileIn, type TargetDistance } from '../api'
import CorosStep from './onboarding/CorosStep'
import ProfileStep from './onboarding/ProfileStep'
import SubmitStep from './onboarding/SubmitStep'

type Step = 'loading' | 'coros' | 'profile' | 'submit' | 'done'

function reconstructProfile(p: Record<string, unknown> | null): ProfileIn | null {
  if (!p) return null
  const required = [
    'display_name', 'dob', 'sex', 'height_cm', 'weight_kg',
    'target_race', 'target_distance', 'target_race_date', 'target_time',
  ]
  for (const k of required) {
    if (p[k] === undefined || p[k] === null) return null
  }
  return {
    display_name: String(p.display_name),
    dob: String(p.dob),
    sex: String(p.sex),
    height_cm: Number(p.height_cm),
    weight_kg: Number(p.weight_kg),
    target_race: String(p.target_race),
    target_distance: String(p.target_distance) as TargetDistance,
    target_race_date: String(p.target_race_date),
    target_time: String(p.target_time),
    pbs: (p.pbs as Record<string, string> | undefined) ?? undefined,
    weekly_mileage_km:
      typeof p.weekly_mileage_km === 'number' ? (p.weekly_mileage_km as number) : undefined,
    constraints:
      typeof p.constraints === 'string' ? (p.constraints as string) : undefined,
  }
}

export default function OnboardingWizard() {
  const [step, setStep] = useState<Step>('loading')
  const [profileData, setProfileData] = useState<ProfileIn | null>(null)

  useEffect(() => {
    getMyProfile()
      .then((p) => {
        if (p.onboarding.completed_at) {
          setStep('done')
        } else if (!p.onboarding.coros_ready) {
          setStep('coros')
        } else if (!p.onboarding.profile_ready) {
          setStep('profile')
        } else {
          // Refresh recovery: reconstruct in-memory profileData from server.
          const reconstructed = reconstructProfile(p.profile)
          if (reconstructed) {
            setProfileData(reconstructed)
          }
          setStep('submit')
        }
      })
      .catch(() => {
        // Profile not yet created — start from step 1
        setStep('coros')
      })
  }, [])

  if (step === 'done') return <Navigate to="/" replace />

  const stepIndex = step === 'coros' ? 0 : step === 'profile' ? 1 : step === 'submit' ? 2 : -1

  return (
    <div className="flex min-h-screen items-start justify-center bg-bg-base px-4 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold text-text-primary tracking-tight">STRIDE 初始化</h1>
          <p className="text-sm text-text-muted mt-1">完成设置以开始使用你的训练仪表盘</p>
        </div>

        {/* Progress dots */}
        {stepIndex >= 0 && (
          <div className="flex items-center justify-center gap-3 mb-8">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`rounded-full transition-all ${
                  i === stepIndex
                    ? 'w-6 h-2 bg-accent-green'
                    : i < stepIndex
                    ? 'w-2 h-2 bg-accent-green/60'
                    : 'w-2 h-2 bg-border-subtle'
                }`}
              />
            ))}
          </div>
        )}

        <div className="bg-bg-card border border-border-subtle rounded-2xl p-8">
          {step === 'loading' && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
            </div>
          )}

          {step === 'coros' && (
            <CorosStep onSuccess={() => setStep('profile')} />
          )}

          {step === 'profile' && (
            <ProfileStep
              onSuccess={(p) => {
                setProfileData(p)
                setStep('submit')
              }}
            />
          )}

          {step === 'submit' && profileData && (
            <SubmitStep profile={profileData} />
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
