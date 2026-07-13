import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAuthStore } from './store/authStore'
import { getMyProfile, type MyProfile } from './api'
import { UserContext } from './UserContextValue'

interface UserProfileState {
  displayName: string
  onboardingCompletedAt: string | null
  coachAgentWeeklyPlan: boolean
}

interface LoadedUserProfile extends UserProfileState {
  userId: string
}

async function loadUserProfile(userId: string): Promise<UserProfileState> {
  try {
    const profile = await getMyProfile()
    return profileToState(profile, userId)
  } catch {
    return { displayName: userId, onboardingCompletedAt: null, coachAgentWeeklyPlan: false }
  }
}

function profileToState(profile: MyProfile, userId: string): UserProfileState {
  return {
    displayName: profile.display_name || userId,
    onboardingCompletedAt: profile.onboarding.completed_at,
    coachAgentWeeklyPlan: profile.features?.coach_agent_weekly_plan ?? false,
  }
}

export function UserProvider({ children }: { children: ReactNode }) {
  const userId = useAuthStore((state) => state.userId)
  const [loadedProfile, setLoadedProfile] = useState<LoadedUserProfile | null>(null)

  const refresh = useCallback(async () => {
    if (!userId) return
    const profile = await loadUserProfile(userId)
    setLoadedProfile({ ...profile, userId })
  }, [userId])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void loadUserProfile(userId).then((profile) => {
      if (!cancelled) setLoadedProfile({ ...profile, userId })
    })
    return () => {
      cancelled = true
    }
  }, [userId])

  if (!userId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  const profileReady = loadedProfile?.userId === userId
  return (
    <UserContext.Provider
      value={{
        user: userId,
        displayName: profileReady ? loadedProfile.displayName : userId,
        profileReady,
        onboardingCompletedAt: profileReady ? loadedProfile.onboardingCompletedAt : null,
        coachAgentWeeklyPlan: profileReady ? loadedProfile.coachAgentWeeklyPlan : false,
        refresh,
      }}
    >
      {children}
    </UserContext.Provider>
  )
}
