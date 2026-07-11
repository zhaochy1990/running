import { createContext, useContext } from 'react'

export interface UserContextType {
  user: string
  displayName: string
  profileReady?: boolean
  onboardingCompletedAt?: string | null
  refresh: () => Promise<void>
}

export const UserContext = createContext<UserContextType>({
  user: '',
  displayName: '',
  profileReady: false,
  onboardingCompletedAt: null,
  refresh: async () => {},
})

export function useUser() {
  return useContext(UserContext)
}
