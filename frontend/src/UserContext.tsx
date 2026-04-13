import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

interface UserContextType {
  user: string
  setUser: (user: string) => void
  users: string[]
}

const UserContext = createContext<UserContextType>({ user: '', setUser: () => {}, users: [] })

export function UserProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<string[]>([])
  const [user, setUserState] = useState(() => localStorage.getItem('stride_user') || '')

  const setUser = (u: string) => {
    setUserState(u)
    localStorage.setItem('stride_user', u)
  }

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((data: { users: string[] }) => {
        setUsers(data.users)
        // If no user selected or current user not in list, pick first
        if (!user || !data.users.includes(user)) {
          if (data.users.length > 0) setUser(data.users[0])
        }
      })
      .catch(() => {})
  }, [])

  return (
    <UserContext.Provider value={{ user, setUser, users }}>
      {user ? children : (
        <div className="flex items-center justify-center min-h-screen">
          <div className="w-5 h-5 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
        </div>
      )}
    </UserContext.Provider>
  )
}

export function useUser() {
  return useContext(UserContext)
}
