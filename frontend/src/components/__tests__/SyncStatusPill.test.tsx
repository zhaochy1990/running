import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { UserContext } from '../../UserContextValue'
import { SYNC_COMPLETED_EVENT } from '../../lib/syncEvents'
import SyncStatusPill from '../SyncStatusPill'

const api = vi.hoisted(() => ({
  getPipelineRun: vi.fn(),
  getWatchInfo: vi.fn(),
  triggerSync: vi.fn(),
}))

vi.mock('../../api', () => api)

describe('SyncStatusPill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getWatchInfo
      .mockResolvedValueOnce({ last_sync_at: null })
      .mockResolvedValueOnce({ last_sync_at: new Date().toISOString() })
    api.triggerSync.mockResolvedValue({
      ok: true,
      status: 202,
      data: { run_id: 'run-1', pipeline_name: 'data_sync' },
    })
    api.getPipelineRun.mockResolvedValue({
      run_id: 'run-1', pipeline_name: 'data_sync', status: 'done', current_step: 2, steps: [],
    })
  })

  it('waits for the Go pipeline before publishing completion', async () => {
    const completed = vi.fn()
    window.addEventListener(SYNC_COMPLETED_EVENT, completed)

    render(
      <UserContext.Provider value={{ user: 'user-1', displayName: 'User', refresh: async () => {} }}>
        <SyncStatusPill />
      </UserContext.Provider>,
    )

    fireEvent.click(await screen.findByTestId('sync-status-pill'))

    await waitFor(() => expect(api.getPipelineRun).toHaveBeenCalledWith('run-1'))
    await waitFor(() => expect(completed).toHaveBeenCalledOnce())
    expect(api.triggerSync).toHaveBeenCalledWith('user-1')
    expect(api.getWatchInfo).toHaveBeenCalledTimes(2)

    window.removeEventListener(SYNC_COMPLETED_EVENT, completed)
  })
})
