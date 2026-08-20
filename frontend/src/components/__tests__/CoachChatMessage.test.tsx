/**
 * Behavioral and security tests for the CoachChatMessage component.
 *
 * Covers: prose container, individual Markdown elements (h3, table,
 * blockquote, list), user vs coach bubble distinction, XSS safety
 * (no rehypeRaw, no javascript: href), and accessibility.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import CoachChatMessage from '../CoachChatMessage'

describe('CoachChatMessage — coach bubble', () => {
  it('wraps content in a prose article element', () => {
    const { container } = render(
      <CoachChatMessage role="coach" content="# Hello" />,
    )
    const article = container.querySelector('article.prose')
    expect(article).toBeInTheDocument()
  })

  it('renders ### headings as <h3>', () => {
    render(<CoachChatMessage role="coach" content="### 结论：训练稳定" />)
    expect(screen.getByRole('heading', { level: 3, name: '结论：训练稳定' })).toBeInTheDocument()
  })

  it('renders a markdown table with thead and tbody', () => {
    const md = `| 指标 | 当前值 | 判断 |
| --- | --- | --- |
| 本月跑量 | 186 km | 稳定 |`
    const { container } = render(<CoachChatMessage role="coach" content={md} />)
    expect(container.querySelector('table')).toBeInTheDocument()
    expect(container.querySelector('thead')).toBeInTheDocument()
    expect(container.querySelector('tbody')).toBeInTheDocument()
    expect(screen.getByText('本月跑量')).toBeInTheDocument()
  })

  it('renders > blockquote as a <blockquote> element', () => {
    const { container } = render(
      <CoachChatMessage role="coach" content="> 建议本周继续保持有氧主体。" />,
    )
    expect(container.querySelector('blockquote')).toBeInTheDocument()
    expect(screen.getByText('建议本周继续保持有氧主体。')).toBeInTheDocument()
  })

  it('renders - list items as <ul><li>', () => {
    const md = `- 如果 HRV 下行，降强度。
- 如果恢复好，继续课表。`
    const { container } = render(<CoachChatMessage role="coach" content={md} />)
    const ul = container.querySelector('ul')
    expect(ul).toBeInTheDocument()
    expect(ul?.querySelectorAll('li')).toHaveLength(2)
  })

  it('includes an accessible label for the coach avatar', () => {
    render(<CoachChatMessage role="coach" content="Hi" />)
    // Avatar must be labelled so screen-readers can identify the sender:
    // accept either a proper img role or an aria-label on the avatar container.
    const hasAccessibleAvatar =
      screen.queryByRole('img') !== null ||
      document.querySelector('[aria-label*="coach"], [aria-label*="Coach"], [aria-label*="教练"]') !== null
    expect(hasAccessibleAvatar).toBe(true)
  })
})

describe('CoachChatMessage — user bubble', () => {
  it('does not wrap content in a prose article', () => {
    const { container } = render(
      <CoachChatMessage role="user" content="我最近练得怎么样？" />,
    )
    expect(container.querySelector('article.prose')).not.toBeInTheDocument()
  })

  it('renders the user message text with a sender label', () => {
    render(<CoachChatMessage role="user" content="我最近练得怎么样？" />)
    expect(screen.getByRole('group', { name: '你的消息' })).toHaveTextContent(
      '我最近练得怎么样？',
    )
  })
})

describe('CoachChatMessage — tool debug bubble', () => {
  it('renders raw tool content inside a collapsible details element', () => {
    const { container } = render(
      <CoachChatMessage role="tool" content="RAW OUTPUT" toolName="search" />,
    )
    expect(container.querySelector('details[data-role="tool"]')).toBeInTheDocument()
    expect(screen.getByText('RAW OUTPUT')).toBeInTheDocument()
    // Tool name is surfaced in the summary.
    expect(screen.getByText(/search/)).toBeInTheDocument()
  })

  it('does not render tool content as markdown prose', () => {
    const { container } = render(<CoachChatMessage role="tool" content="# not a heading" />)
    expect(container.querySelector('article.prose')).not.toBeInTheDocument()
    expect(container.querySelector('h1')).not.toBeInTheDocument()
  })
})

describe('CoachChatMessage — event receipt bar', () => {
  it('renders an applied event as a positive (green) status bar, not markdown', () => {
    const { container } = render(
      <CoachChatMessage role="event" content="已启用本周课表调整" eventStatus="applied" />,
    )
    const bar = container.querySelector('[data-role="event"]')
    expect(bar).toBeInTheDocument()
    expect(bar).toHaveAttribute('data-status', 'applied')
    expect(bar).toHaveAttribute('role', 'status')
    // Not markdown / assistant prose.
    expect(container.querySelector('article.prose')).not.toBeInTheDocument()
    expect(screen.getByText('已启用本周课表调整')).toBeInTheDocument()
  })

  it('renders an abandoned event as a neutral status bar', () => {
    const { container } = render(
      <CoachChatMessage role="event" content="已放弃该调整方案" eventStatus="abandoned" />,
    )
    const bar = container.querySelector('[data-role="event"]')
    expect(bar).toHaveAttribute('data-status', 'abandoned')
    // Neutral bars must not carry the accent-green text class.
    expect(bar?.className).not.toContain('text-accent-green')
  })

  it('does not interpret event content as markdown', () => {
    const { container } = render(
      <CoachChatMessage role="event" content="# 不是标题" eventStatus="applied" />,
    )
    expect(container.querySelector('h1')).not.toBeInTheDocument()
    expect(screen.getByText('# 不是标题')).toBeInTheDocument()
  })
})

describe('CoachChatMessage — XSS safety', () => {
  it('does not execute injected <script> tags', () => {
    // If rehypeRaw were enabled, this would inject a live <script>.
    // react-markdown's default behavior strips script elements.
    const evil = '<script>window.__xss_executed = true</script>after'
    render(<CoachChatMessage role="coach" content={evil} />)
    // The text "after" may or may not appear depending on implementation,
    // but the global must never be set.
    expect((window as unknown as Record<string, unknown>).__xss_executed).toBeUndefined()
  })

  it('does not render javascript: href as a clickable link', () => {
    const md = '[click me](javascript:alert(1))'
    render(<CoachChatMessage role="coach" content={md} />)
    const links = document.querySelectorAll('a[href^="javascript:"]')
    expect(links).toHaveLength(0)
  })
})
