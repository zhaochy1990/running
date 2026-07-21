import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CreateReview } from '../CreateReview'

describe('CreateReview', () => {
  it('appends the Chinese weekday to ISO date card titles', () => {
    // 2026-07-20 is a Monday.
    render(<CreateReview days={[{ label: '2026-07-20', detail: '轻松跑 8 km' }]} />)
    expect(screen.getByText('2026-07-20 · 周一')).toBeInTheDocument()
  })

  it('appends the correct weekday across the week', () => {
    render(
      <CreateReview
        days={[
          { label: '2026-07-21', detail: 'x' }, // Tue
          { label: '2026-07-26', detail: 'y' }, // Sun
        ]}
      />,
    )
    expect(screen.getByText('2026-07-21 · 周二')).toBeInTheDocument()
    expect(screen.getByText('2026-07-26 · 周日')).toBeInTheDocument()
  })

  it('does not duplicate a weekday already present in the label', () => {
    render(<CreateReview days={[{ label: '2026-07-20 周一', detail: 'x' }]} />)
    expect(screen.getByText('2026-07-20 周一')).toBeInTheDocument()
    // No doubled suffix.
    expect(screen.queryByText(/周一\s*周一/)).not.toBeInTheDocument()
  })

  it('leaves non-ISO labels untouched', () => {
    render(<CreateReview days={[{ label: '周一', detail: 'x' }]} />)
    expect(screen.getByText('周一')).toBeInTheDocument()
  })

  it('renders the detail text', () => {
    render(<CreateReview days={[{ label: '2026-07-20', detail: '轻松跑 8 km' }]} />)
    expect(screen.getByText('轻松跑 8 km')).toBeInTheDocument()
  })

  it('renders a standalone strength section with sets, target, rest, and note', () => {
    render(
      <CreateReview
        days={[]}
        strength={[
          {
            label: '2026-07-21',
            title: '下肢力量 A',
            note: '动作缓慢控制',
            exercises: [
              { name: '高脚杯深蹲', sets: 3, target: '12 次', rest: '休息 90 秒', note: '核心收紧' },
            ],
          },
        ]}
      />,
    )
    expect(screen.getByText('力量训练')).toBeInTheDocument()
    expect(screen.getByText('高脚杯深蹲')).toBeInTheDocument()
    expect(screen.getByText(/3 组/)).toBeInTheDocument()
    expect(screen.getByText(/12 次/)).toBeInTheDocument()
    expect(screen.getByText(/休息 90 秒/)).toBeInTheDocument()
    expect(screen.getByText(/核心收紧/)).toBeInTheDocument()
    expect(screen.getByText('动作缓慢控制')).toBeInTheDocument()
  })

  it('renders a standalone nutrition section with macros, water, and meals', () => {
    render(
      <CreateReview
        days={[]}
        nutrition={[
          {
            label: '2026-07-20',
            kcalTarget: 2400,
            carbsG: 320,
            proteinG: 130,
            fatG: 70,
            waterMl: 2500,
            notesMd: '跑后补糖',
            meals: [{ name: '早餐', timeHint: '7:30', kcal: 600, carbsG: 80, proteinG: 25, fatG: 15, itemsMd: '燕麦 + 鸡蛋' }],
          },
        ]}
      />,
    )
    expect(screen.getByText('营养安排')).toBeInTheDocument()
    expect(screen.getByText(/热量 2400 kcal/)).toBeInTheDocument()
    expect(screen.getByText(/饮水 2500 ml/)).toBeInTheDocument()
    expect(screen.getByText('早餐')).toBeInTheDocument()
    // Per-meal macros are retained and shown.
    expect(screen.getByText(/600 kcal/)).toBeInTheDocument()
    expect(screen.getByText(/碳水 80 g/)).toBeInTheDocument()
    expect(screen.getByText(/蛋白 25 g/)).toBeInTheDocument()
    expect(screen.getByText(/脂肪 15 g/)).toBeInTheDocument()
    expect(screen.getByText(/燕麦 \+ 鸡蛋/)).toBeInTheDocument()
    expect(screen.getByText('跑后补糖')).toBeInTheDocument()
  })

  it('renders the weekly note first and never renders a duplicate coach explanation', () => {
    const { container } = render(
      <CreateReview
        days={[{ label: '2026-07-20', detail: '轻松跑' }]}
        notesMd={'本周重点：**恢复**为主 <img src=x onerror="alert(1)">'}
      />,
    )
    const noteHeading = screen.getByText('本周说明')
    const calendarHeading = screen.getByText('本周训练日历')
    expect(
      noteHeading.compareDocumentPosition(calendarHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.queryByText('教练说明')).not.toBeInTheDocument()
    expect(container.querySelector('strong')?.textContent).toBe('恢复')
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders the weekly note as Markdown and never as raw HTML', () => {
    const { container } = render(
      <CreateReview
        days={[]}
        notesMd={'本周重点：**恢复**为主 <img src=x onerror="alert(1)">'}
      />,
    )
    expect(screen.getByText('本周说明')).toBeInTheDocument()
    // Markdown emphasis is rendered…
    expect(container.querySelector('strong')?.textContent).toBe('恢复')
    // …but raw HTML is inert (no injected <img> element).
    expect(container.querySelector('img')).toBeNull()
  })

  it('omits empty sections', () => {
    render(<CreateReview days={[{ label: '2026-07-20', detail: '轻松跑' }]} />)
    expect(screen.queryByText('力量训练')).not.toBeInTheDocument()
    expect(screen.queryByText('营养安排')).not.toBeInTheDocument()
    expect(screen.queryByText('本周说明')).not.toBeInTheDocument()
  })
})
