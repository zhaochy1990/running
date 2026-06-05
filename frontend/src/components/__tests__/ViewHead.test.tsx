import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ViewHead from '../ViewHead'

describe('ViewHead', () => {
  it('renders title as level-1 heading', () => {
    render(<ViewHead title="Hello" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeInTheDocument()
  })

  it('renders eyebrow, lede, and actions when provided', () => {
    render(
      <ViewHead
        title="训练计划"
        eyebrow="训练计划 · 23 周"
        lede="为下一场马拉松而准备的周期化方案"
        actions={<button>新建</button>}
      />,
    )
    expect(screen.getByText('训练计划 · 23 周')).toBeInTheDocument()
    expect(screen.getByText('为下一场马拉松而准备的周期化方案')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建' })).toBeInTheDocument()
  })

  it('allows page-specific lede width overrides', () => {
    render(
      <ViewHead
        title="活动列表"
        lede="来自 COROS / Garmin 自动同步并匹配课次。点击任意活动查看完整详情、分段与教练点评。"
        ledeClassName="max-w-none lg:whitespace-nowrap"
      />,
    )

    const lede = screen.getByText('来自 COROS / Garmin 自动同步并匹配课次。点击任意活动查看完整详情、分段与教练点评。')
    expect(lede).toHaveClass('max-w-none')
    expect(lede).toHaveClass('lg:whitespace-nowrap')
    expect(lede).not.toHaveClass('max-w-[520px]')
  })

  it('omits eyebrow paragraph when eyebrow prop is undefined', () => {
    render(<ViewHead title="Solo" />)
    expect(screen.queryByText('训练计划 · 23 周')).not.toBeInTheDocument()
    const headingParent = screen.getByRole('heading', { level: 1, name: 'Solo' }).parentElement
    const monoLabel = headingParent?.querySelector('p.font-mono')
    expect(monoLabel).toBeNull()
  })
})
