/**
 * Covers the load-state props added to the adjust adapter Views (items 3/4):
 * intake emptyTarget + summary loading/error text. Kept in a separate file from
 * the core apply/discard behavior tests to avoid edit collisions.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WeeklyPlanAdjustView } from '../WeeklyPlanAdjustPage'
import { MasterPlanAdjustView } from '../MasterPlanAdjustPage'
const noStash = vi.fn(() => null)

function weeklyView(extra: Record<string, unknown>) {
  return render(
    <WeeklyPlanAdjustView
      userId="u1"
      folder="W1"
      readStash={noStash}
      clearStash={vi.fn()}
      apply={vi.fn(async () => ({ status: 'ok' as const }))}
      abandon={vi.fn(async () => {})}
      navigate={vi.fn()}
      currentPlanSummary="本周课表 · 2026-07-13 – 2026-07-19 · 计划跑量 32.0 km · 5 训练课"
      renderChat={() => <div data-testid="chat">chat</div>}
      {...extra}
    />,
  )
}

describe('WeeklyPlanAdjustView load states', () => {
  it('shows a loading summary while the plan loads', () => {
    weeklyView({ summaryLoading: true })
    expect(screen.getByText('加载当前计划…')).toBeInTheDocument()
  })

  it('shows an error summary on load failure', () => {
    weeklyView({ summaryError: 'API error: 500' })
    expect(screen.getByText(/无法加载当前计划/)).toBeInTheDocument()
  })

  it('shows the create prompt when the target week has no plan', () => {
    weeklyView({ emptyTarget: true })
    expect(screen.getByText(/这一周还没有计划/)).toBeInTheDocument()
  })

  it('shows the resolved summary otherwise', () => {
    weeklyView({})
    expect(screen.getByText(/计划跑量 32.0 km · 5 训练课/)).toBeInTheDocument()
  })
})

describe('MasterPlanAdjustView load states', () => {
  function masterView(extra: Record<string, unknown>) {
    return render(
      <MasterPlanAdjustView
        userId="u1"
        planId="plan-9"
        readStash={vi.fn(() => null)}
        clearStash={vi.fn()}
        apply={vi.fn(async () => ({ status: 'ok' as const }))}
        abandon={vi.fn(async () => {})}
        navigate={vi.fn()}
        currentPlanSummary="上海马拉松 · 第 7/16 周 · 版本 v4"
        renderChat={() => <div data-testid="chat">chat</div>}
        {...extra}
      />,
    )
  }

  it('shows a loading summary', () => {
    masterView({ summaryLoading: true })
    expect(screen.getByText('加载当前赛季计划…')).toBeInTheDocument()
  })

  it('shows an error summary', () => {
    masterView({ summaryError: 'API error: 500' })
    expect(screen.getByText(/无法加载赛季计划/)).toBeInTheDocument()
  })

  it('shows the resolved race / period / version summary', () => {
    masterView({})
    expect(screen.getByText(/上海马拉松 · 第 7\/16 周 · 版本 v4/)).toBeInTheDocument()
  })
})
