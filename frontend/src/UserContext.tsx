import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAuthStore } from './store/authStore'
import { getMyProfile, type MyProfile } from './api'
import { UserContext } from './UserContextValue'

interface UserProfileState {
  displayName: string
  onboardingCompletedAt: string | null
}

async function loadUserProfile(userId: string): Promise<UserProfileState> {
  try {
    const profile = await getMyProfile()
    return profileToState(profile, userId)
  } catch {
    return { displayName: userId, onboardingCompletedAt: null }
  }
}

function profileToState(profile: MyProfile, userId: string): UserProfileState {
  return {
    displayName: profile.display_name || userId,
    onboardingCompletedAt: profile.onboarding.completed_at,
  }
}

export function UserProvider({ children }: { children: ReactNode }) {
  const userId = useAuthStore((s) => s.userId)
  const [displayName, setDisplayName] = useState<string>('')
  const [onboardingCompletedAt, setOnboardingCompletedAt] = useState<string | null>(null)
  const [profileReady, setProfileReady] = useState(false)

  const applyProfile = useCallback((state: UserProfileState) => {
    setDisplayName(state.displayName)
    setOnboardingCompletedAt(state.onboardingCompletedAt)
    setProfileReady(true)
  }, [])

  const refresh = useCallback(async () => {
    if (!userId) return
    applyProfile(await loadUserProfile(userId))
  }, [applyProfile, userId])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setProfileReady(false)
    void loadUserProfile(userId).then((state) => {
      if (!cancelled) applyProfile(state)
    })
    return () => {
      cancelled = true
    }
  }, [applyProfile, userId])

  if (!userId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <UserContext.Provider value={{ user: userId, displayName: displayName || userId, profileReady, onboardingCompletedAt, refresh }}>
      {children}
    </UserContext.Provider>
  )
}
