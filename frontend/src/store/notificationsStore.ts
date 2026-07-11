import { create } from 'zustand'
import { getNotificationReadState, markNotificationRead } from '../api'
import { NOTIFICATIONS, type AppNotification } from '../data/notifications'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

let hydratePromise: Promise<void> | null = null

interface NotificationsState {
  readIds: Set<string>
  loadState: LoadState
  error: string | null
  hydrate: () => Promise<void>
  markRead: (id: string) => Promise<void>
  isRead: (id: string) => boolean
  // Number of unread (= not-read) messages, for the bell badge.
  unreadCount: (notifications?: readonly AppNotification[]) => number
}

function normalizeReadIds(ids: unknown): Set<string> {
  if (!Array.isArray(ids)) return new Set()
  return new Set(ids.filter((item): item is string => typeof item === 'string'))
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  readIds: new Set(),
  loadState: 'idle',
  error: null,

  hydrate: async () => {
    const state = get()
    if (state.loadState === 'ready') return
    if (hydratePromise) return hydratePromise

    hydratePromise = getNotificationReadState()
      .then(({ read_ids }) => {
        set({
          readIds: normalizeReadIds(read_ids),
          loadState: 'ready',
          error: null,
        })
      })
      .catch((err) => {
        set({ loadState: 'error', error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        hydratePromise = null
      })

    set({ loadState: 'loading', error: null })
    return hydratePromise
  },

  markRead: async (id: string) => {
    if (get().loadState !== 'ready') {
      await get().hydrate()
    }

    const previous = get().readIds
    const optimistic = new Set(previous)
    optimistic.add(id)
    set({ readIds: optimistic, error: null })

    try {
      const { read_ids } = await markNotificationRead(id)
      set({ readIds: normalizeReadIds(read_ids), loadState: 'ready', error: null })
    } catch (err) {
      set({ readIds: previous, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  isRead: (id: string) => get().readIds.has(id),

  unreadCount: (notifications = NOTIFICATIONS) => {
    return notifications.reduce((acc, notification) => acc + (get().isRead(notification.id) ? 0 : 1), 0)
  },
}))
