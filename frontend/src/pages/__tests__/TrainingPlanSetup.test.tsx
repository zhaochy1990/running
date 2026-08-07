import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createRunningProfile: vi.fn(),
  createTrainingGoal: vi.fn(),
  generateMasterPlan: vi.fn(),
  getMasterPlanJob: vi.fn(),
  getPipelineRun: vi.fn(),
  triggerSync: vi.fn(),
}))

vi.mock('../../api', () => ({
  createRunningProfile: mocks.createRunningProfile,
  createTrainingGoal: mocks.createTrainingGoal,
  generateMasterPlan: mocks.generateMasterPlan,
  getMasterPlanJob: mocks.getMasterPlanJob,
  getPipelineRun: mocks.getPipelineRun,
  triggerSync: mocks.triggerSync,
}))

import TrainingPlanSetup from '../TrainingPlanSetup'

const runningRun = {
  run_id: 'sync-run-1',
  pipeline_name: 'onboarding',
  status: 'running' as const,
  current_step: 0,
  steps: [
    { name: 'sync', job_type: 'sync', status: 'running' },
    { name: 'calibration', job_type: 'calibration', status: 'queued' },
  ],
}

function renderSetup(userId = 'user-1') {
  return render(<TrainingPlanSetup userId={userId} onDraftReady={vi.fn()} />)
}

function fillRequiredGoalFields() {
  fireEvent.click(screen.getAllByRole('button', { name: '全马' })[0])
  fireEvent.change(screen.getByLabelText('目标赛事'), { target: { value: '测试马拉松' } })
  fireEvent.change(screen.getByLabelText('比赛日期'), { target: { value: '2026-10-11' } })
  fireEvent.click(screen.getByRole('button', { name: '5' }))
}

describe('TrainingPlanSetup', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
    mocks.createTrainingGoal.mockResolvedValue({ ok: true, data: { goal_id: 'goal-1' } })
    mocks.createRunningProfile.mockResolvedValue({ ok: true, data: {} })
    mocks.triggerSync.mockResolvedValue({ ok: true, data: { run_id: 'sync-run-1', pipeline_name: 'onboarding' } })
    mocks.getPipelineRun.mockResolvedValue(runningRun)
  })

  it('starts and polls the generic full-sync pipeline', async () => {
    renderSetup()
    fillRequiredGoalFields()
    fireEvent.click(screen.getByRole('button', { name: '生成我的赛季计划' }))

    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledWith('user-1', { full: true }))
    expect(localStorage.getItem('stride:training-plan-sync-run:user-1')).toBe('sync-run-1')
    await waitFor(() => expect(mocks.getPipelineRun).toHaveBeenCalledWith('sync-run-1'))
    expect(screen.getByText('Pipeline')).toBeInTheDocument()
    expect(screen.getByText('onboarding')).toBeInTheDocument()
  })

  it('recovers and polls a persisted full-sync run without starting another', async () => {
    localStorage.setItem('stride:training-plan-sync-run:user-1', 'saved-run')
    mocks.getPipelineRun.mockResolvedValue({ ...runningRun, run_id: 'saved-run' })

    renderSetup()

    await waitFor(() => expect(mocks.getPipelineRun).toHaveBeenCalledWith('saved-run'))
    expect(mocks.triggerSync).not.toHaveBeenCalled()
    expect(screen.getByText('正在读取你的训练历史')).toBeInTheDocument()
  })

  it('clears a terminal failed run before retrying', async () => {
    localStorage.setItem('stride:training-plan-sync-run:user-1', 'failed-run')
    mocks.getPipelineRun.mockResolvedValueOnce({
      ...runningRun,
      run_id: 'failed-run',
      status: 'failed',
      error_message: '同步失败',
    })

    renderSetup()

    expect(await screen.findByRole('button', { name: '重新同步' })).toBeInTheDocument()
    expect(localStorage.getItem('stride:training-plan-sync-run:user-1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新同步' }))
    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledWith('user-1', { full: true }))
  })
})
