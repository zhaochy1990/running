import { create } from 'zustand'
import { getNotificationReadState, getNotifications, markNotificationRead } from '../api'
import {
  NOTIFICATIONS,
  type AppNotification,
  fromServerNotification,
} from '../data/notifications'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

let hydratePromise: Promise<void> | null = null

interface NotificationsState {
  readIds: Set<string>
  serverNotifications: AppNotification[]
  loadState: LoadState
  error: string | null
  hydrate: () => Promise<void>
  refresh: () => Promise<void>
  markRead: (id: string) => Promise<void>
  isRead: (id: string) => boolean
  // Number of unread (= not-read) messages, for the bell badge.
  unreadCount: (notifications?: readonly AppNotification[]) => number
}

function markServerNotificationRead(
  notifications: AppNotification[],
  readIds: Set<string>,
): AppNotification[] {
  return notifications.map((notification) => {
    if (!readIds.has(notification.id)) return notification
    if (notification.read === true) return notification
    return { ...notification, read: true }
  })
}

function normalizeReadIds(ids: unknown): Set<string> {
  if (!Array.isArray(ids)) return new Set()
  return new Set(ids.filter((item): item is string => typeof item === 'string'))
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  readIds: new Set(),
  serverNotifications: [],
  loadState: 'idle',
  error: null,

  hydrate: async () => {
    const state = get()
    if (state.loadState === 'ready') return
    if (hydratePromise) return hydratePromise

    hydratePromise = getNotifications()
      .then(({ read_ids, notifications }) => {
        set({
          readIds: normalizeReadIds(read_ids),
          serverNotifications: notifications.map(fromServerNotification),
          loadState: 'ready',
          error: null,
        })
      })
      .catch((err) => {
        return getNotificationReadState()
          .then(({ read_ids }) => {
            set({
              readIds: normalizeReadIds(read_ids),
              serverNotifications: [],
              loadState: 'ready',
              error: null,
            })
          })
          .catch(() => {
            set({ loadState: 'error', error: err instanceof Error ? err.message : String(err) })
          })
      })
      .finally(() => {
        hydratePromise = null
      })

    set({ loadState: 'loading', error: null })
    return hydratePromise
  },

  refresh: async () => {
    try {
      const { read_ids, notifications } = await getNotifications()
      set({
        readIds: normalizeReadIds(read_ids),
        serverNotifications: notifications.map(fromServerNotification),
        loadState: 'ready',
        error: null,
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
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
      const readIds = normalizeReadIds(read_ids)
      set({
        readIds,
        serverNotifications: markServerNotificationRead(get().serverNotifications, readIds),
        loadState: 'ready',
        error: null,
      })
    } catch (err) {
      set({ readIds: previous, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },

  isRead: (id: string) => {
    const server = get().serverNotifications.find((n) => n.id === id)
    if (server && typeof server.read === 'boolean') return server.read
    return get().readIds.has(id)
  },

  unreadCount: (notifications = NOTIFICATIONS) => {
    return notifications.reduce((acc, notification) => acc + (get().isRead(notification.id) ? 0 : 1), 0)
  },
}))
