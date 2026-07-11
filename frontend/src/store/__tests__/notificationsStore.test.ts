import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOTIFICATIONS, getNotificationsForUser } from '../../data/notifications'

const newestNotificationId = NOTIFICATIONS[0]?.id ?? 'notification-1'
const secondNotificationId = NOTIFICATIONS[1]?.id ?? 'notification-2'

describe('notificationsStore server-backed read state', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('hides historical notifications for users who completed onboarding later', () => {
    expect(getNotificationsForUser('2026-07-11T00:00:00+08:00')).toEqual([])
    expect(getNotificationsForUser('2026-04-23T00:00:00+08:00').map((n) => n.id)).toEqual(
      NOTIFICATIONS.map((n) => n.id),
    )
  })

  it('hydrates read ids from the API instead of localStorage', async () => {
    localStorage.setItem('stride.dismissedNotifications', JSON.stringify(NOTIFICATIONS.map(n => n.id)))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ read_ids: [newestNotificationId], notifications: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { useNotificationsStore } = await import('../notificationsStore')

    expect(useNotificationsStore.getState().unreadCount()).toBe(NOTIFICATIONS.length)

    await useNotificationsStore.getState().hydrate()

    expect(fetchMock).toHaveBeenCalledWith('/api/users/me/notifications', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
    expect(useNotificationsStore.getState().isRead(newestNotificationId)).toBe(true)
    expect(useNotificationsStore.getState().unreadCount()).toBe(NOTIFICATIONS.length - 1)
  })

  it('marks a notification read through the API and keeps local render state in sync', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [], notifications: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [newestNotificationId], notifications: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const { useNotificationsStore } = await import('../notificationsStore')

    await useNotificationsStore.getState().hydrate()
    await useNotificationsStore.getState().markRead(newestNotificationId)

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/users/me/notifications/${newestNotificationId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    })
    expect(useNotificationsStore.getState().isRead(newestNotificationId)).toBe(true)
    expect(localStorage.getItem('stride.dismissedNotifications')).toBeNull()
  })

  it('hydrates before marking read when called from an idle store', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [newestNotificationId], notifications: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [newestNotificationId, secondNotificationId] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const { useNotificationsStore } = await import('../notificationsStore')

    await useNotificationsStore.getState().markRead(secondNotificationId)

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/users/me/notifications', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/users/me/notifications/${secondNotificationId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    })
    expect(useNotificationsStore.getState().isRead(newestNotificationId)).toBe(true)
    expect(useNotificationsStore.getState().isRead(secondNotificationId)).toBe(true)
  })

  it('hydrates server inbox notifications and treats updated unread state as authoritative', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        read_ids: [],
        notifications: [
          {
            id: 'sync:full',
            severity: 'info',
            title: '正在同步数据',
            body: '正在准备同步历史训练数据',
            published_at: '2026-07-11T08:00:00+00:00',
            updated_at: '2026-07-11T08:00:00+00:00',
            action_url: '/plan',
            progress_pct: 10,
            metadata: { type: 'sync', state: 'running' },
            read: false,
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { useNotificationsStore } = await import('../notificationsStore')

    await useNotificationsStore.getState().hydrate()

    expect(useNotificationsStore.getState().serverNotifications).toHaveLength(1)
    expect(useNotificationsStore.getState().serverNotifications[0].progressPct).toBe(10)
    expect(useNotificationsStore.getState().isRead('sync:full')).toBe(false)
    expect(useNotificationsStore.getState().unreadCount([
      useNotificationsStore.getState().serverNotifications[0],
    ])).toBe(1)
  })

  it('marks hydrated server inbox notifications read immediately after API success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        read_ids: [],
        notifications: [
          {
            id: 'sync:full',
            severity: 'info',
            title: '正在同步数据',
            body: '正在准备同步历史训练数据',
            published_at: '2026-07-11T08:00:00+00:00',
            updated_at: '2026-07-11T08:00:00+00:00',
            progress_pct: 10,
            metadata: { type: 'sync', state: 'running' },
            read: false,
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: ['sync:full'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const { useNotificationsStore } = await import('../notificationsStore')

    await useNotificationsStore.getState().hydrate()
    await useNotificationsStore.getState().markRead('sync:full')

    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/users/me/notifications/sync%3Afull/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    })
    expect(useNotificationsStore.getState().serverNotifications[0].read).toBe(true)
    expect(useNotificationsStore.getState().isRead('sync:full')).toBe(true)
    expect(useNotificationsStore.getState().unreadCount([
      useNotificationsStore.getState().serverNotifications[0],
    ])).toBe(0)
  })

})
