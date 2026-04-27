import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useAuthStore } from './store/authStore'
import { getMyProfile } from './api'

interface UserContextType {
  user: string
  displayName: string
}

const UserContext = createContext<UserContextType>({ user: '', displayName: '' })

export function UserProvider({ children }: { children: ReactNode }) {
  const userId = useAuthStore((s) => s.userId)
  const [displayName, setDisplayName] = useState<string>('')

  useEffect(() => {
    if (!userId) return
    getMyProfile()
      .then((profile) => setDisplayName(profile.display_name || userId))
      .catch(() => setDisplayName(userId || ''))
  }, [userId])

  if (!userId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <UserContext.Provider value={{ user: userId, displayName: displayName || userId }}>
      {children}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
