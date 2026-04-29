import { createContext, useContext } from 'react'

export interface UserContextType {
  user: string
  displayName: string
  refresh: () => Promise<void>
}

export const UserContext = createContext<UserContextType>({
  user: '',
  displayName: '',
  refresh: async () => {},
})

export function useUser() {
  return useContext(UserContext)
}
