import { createContext, useContext } from 'react'

export interface UserContextType {
  user: string
  displayName: string
  profileReady?: boolean
  onboardingCompletedAt?: string | null
  coachAgentWeeklyPlan?: boolean
  coachChat?: boolean
  coachChatDebug?: boolean
  coachChatMaxMessageChars?: number
  refresh: () => Promise<void>
}

export const UserContext = createContext<UserContextType>({
  user: '',
  displayName: '',
  profileReady: false,
  onboardingCompletedAt: null,
  coachAgentWeeklyPlan: false,
  coachChat: false,
  coachChatDebug: false,
  coachChatMaxMessageChars: undefined,
  refresh: async () => {},
})

export function useUser() {
  return useContext(UserContext)
}
