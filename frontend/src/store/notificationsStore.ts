import { create } from 'zustand'
import { NOTIFICATIONS, type AppNotification, getNotificationsNewestFirst } from '../data/notifications'

const STORAGE_KEY = 'stride.dismissedNotifications'

function loadDismissed(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

function saveDismissed(ids: Set<string>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch { /* quota / disabled */ }
}

interface NotificationsState {
  dismissed: Set<string>
  dismiss: (id: string) => void
  isDismissed: (id: string) => boolean
  // The first message that hasn't been dismissed (newest-first); shown in popup.
  pendingPopup: () => AppNotification | undefined
  // Number of unread (= not-dismissed) messages, for the bell badge.
  unreadCount: () => number
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  dismissed: loadDismissed(),

  dismiss: (id: string) => {
    const next = new Set(get().dismissed)
    next.add(id)
    saveDismissed(next)
    set({ dismissed: next })
  },

  isDismissed: (id: string) => get().dismissed.has(id),

  pendingPopup: () => {
    const dismissed = get().dismissed
    return getNotificationsNewestFirst().find((n) => !dismissed.has(n.id))
  },

  unreadCount: () => {
    const dismissed = get().dismissed
    return NOTIFICATIONS.reduce((acc, n) => acc + (dismissed.has(n.id) ? 0 : 1), 0)
  },
}))
