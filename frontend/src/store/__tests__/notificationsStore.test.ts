import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOTIFICATIONS } from '../../data/notifications'

const oldestNotificationId = NOTIFICATIONS[0]?.id ?? 'notification-1'
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

  it('hydrates read ids from the API instead of localStorage', async () => {
    localStorage.setItem('stride.dismissedNotifications', JSON.stringify(NOTIFICATIONS.map(n => n.id)))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ read_ids: [oldestNotificationId] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const { useNotificationsStore } = await import('../notificationsStore')

    expect(useNotificationsStore.getState().unreadCount()).toBe(NOTIFICATIONS.length)

    await useNotificationsStore.getState().hydrate()

    expect(fetchMock).toHaveBeenCalledWith('/api/users/me/notifications/read-state', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
    expect(useNotificationsStore.getState().isRead(oldestNotificationId)).toBe(true)
    expect(useNotificationsStore.getState().unreadCount()).toBe(NOTIFICATIONS.length - 1)
  })

  it('marks a notification read through the API and keeps local render state in sync', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [oldestNotificationId] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const { useNotificationsStore } = await import('../notificationsStore')

    await useNotificationsStore.getState().hydrate()
    await useNotificationsStore.getState().markRead(oldestNotificationId)

    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/users/me/notifications/${oldestNotificationId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    })
    expect(useNotificationsStore.getState().isRead(oldestNotificationId)).toBe(true)
    expect(localStorage.getItem('stride.dismissedNotifications')).toBeNull()
  })

  it('hydrates before marking read when called from an idle store', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [oldestNotificationId] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ read_ids: [oldestNotificationId, secondNotificationId] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const { useNotificationsStore } = await import('../notificationsStore')

    await useNotificationsStore.getState().markRead(secondNotificationId)

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/users/me/notifications/read-state', {
      method: 'GET',
      headers: {},
      body: undefined,
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/users/me/notifications/${secondNotificationId}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: undefined,
    })
    expect(useNotificationsStore.getState().isRead(oldestNotificationId)).toBe(true)
    expect(useNotificationsStore.getState().isRead(secondNotificationId)).toBe(true)
  })
})
