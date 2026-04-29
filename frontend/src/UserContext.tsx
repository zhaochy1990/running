import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAuthStore } from './store/authStore'
import { getMyProfile } from './api'
import { UserContext } from './UserContextValue'

async function loadDisplayName(userId: string): Promise<string> {
  try {
    const profile = await getMyProfile()
    return profile.display_name || userId
  } catch {
    return userId
  }
}

export function UserProvider({ children }: { children: ReactNode }) {
  const userId = useAuthStore((s) => s.userId)
  const [displayName, setDisplayName] = useState<string>('')

  const refresh = useCallback(async () => {
    if (!userId) return
    setDisplayName(await loadDisplayName(userId))
  }, [userId])

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void loadDisplayName(userId).then((name) => {
      if (!cancelled) setDisplayName(name)
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

  return (
    <UserContext.Provider value={{ user: userId, displayName: displayName || userId, refresh }}>
      {children}
    </UserContext.Provider>
  )
}
