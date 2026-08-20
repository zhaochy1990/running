import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlanAdjustIntakeWorkspace } from '../PlanAdjustIntakeWorkspace'

describe('PlanAdjustIntakeWorkspace', () => {
  it('titles the weekly intake "调整训练周" (not "本周")', () => {
    render(
      <PlanAdjustIntakeWorkspace
        kind="weekly"
        currentPlanSummary="7/27 — 8/2 · 计划跑量 105.3 km · 7 训练课"
        chat={<div data-testid="chat">chat</div>}
      />,
    )
    expect(screen.getByRole('main', { name: '调整训练周' })).toBeInTheDocument()
    expect(screen.queryByText('调整本周计划')).not.toBeInTheDocument()
  })

  it('renders the current-plan detail below the summary when provided', () => {
    render(
      <PlanAdjustIntakeWorkspace
        kind="weekly"
        currentPlanSummary="7/27 — 8/2 · 计划跑量 105.3 km · 7 训练课"
        currentPlanDetail={<div data-testid="plan-detail">完整周计划</div>}
        chat={<div data-testid="chat">chat</div>}
      />,
    )
    expect(screen.getByText('7/27 — 8/2 · 计划跑量 105.3 km · 7 训练课')).toBeInTheDocument()
    expect(screen.getByTestId('plan-detail')).toBeInTheDocument()
  })

  it('keeps the master intake title unchanged', () => {
    render(
      <PlanAdjustIntakeWorkspace
        kind="master"
        currentPlanSummary="上海马拉松 · 第 7/16 周 · 版本 v4"
        chat={<div data-testid="chat">chat</div>}
      />,
    )
    expect(screen.getByRole('main', { name: '调整赛季计划' })).toBeInTheDocument()
  })
})
