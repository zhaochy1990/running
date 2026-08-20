/**
 * CoachChatMessage — one chat bubble.
 *
 * Coach turns render sanitized GFM Markdown inside a `prose` article. We use
 * react-markdown + remark-gfm and NEVER enable rehypeRaw, so raw HTML in the
 * model output is inert. Links are additionally sanitized (javascript: hrefs
 * dropped, external links get rel="noopener noreferrer").
 *
 * User turns render as plain text (no Markdown), so the athlete's own message
 * can never be interpreted as markup.
 */
import type { ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { AssistantPart, ChatMessageViewRole } from '../types/coachChat'

export interface CoachChatMessageProps {
  role: ChatMessageViewRole
  content: string
  refusal?: boolean
  /** Debug-user-only structured parts (reasoning / tool_meta). */
  parts?: AssistantPart[]
  /** When true, render collapsible reasoning/tool_meta parts. */
  showDebug?: boolean
  /** Tool name, for debug tool views. */
  toolName?: string | null
  /** Event status (role="event"): `applied` → positive, else neutral. */
  eventStatus?: string | null
}

/** Only http(s) and mailto links are allowed to render as clickable anchors. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  const trimmed = href.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  // Relative links are allowed; anything with a disallowed scheme is dropped.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined
  return trimmed
}

function MarkdownLink({ href, children, ...rest }: ComponentPropsWithoutRef<'a'>) {
  const safe = safeHref(href)
  if (!safe) {
    // Render the link text without an href so it is not clickable.
    return <span {...rest}>{children}</span>
  }
  const external = /^https?:/i.test(safe)
  return (
    <a
      href={safe}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...rest}
    >
      {children}
    </a>
  )
}

function MarkdownTable({ children, ...rest }: ComponentPropsWithoutRef<'table'>) {
  // Wrap tables so wide content scrolls horizontally instead of overflowing.
  return (
    <div className="overflow-x-auto">
      <table {...rest}>{children}</table>
    </div>
  )
}

const markdownComponents = {
  a: MarkdownLink,
  table: MarkdownTable,
}

function CoachAvatar() {
  return (
    <div
      role="img"
      aria-label="Coach"
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-green/15 font-mono text-xs font-bold text-accent-green"
    >
      C
    </div>
  )
}

function DebugParts({ parts }: { parts: AssistantPart[] }) {
  const debug = parts.filter((p) => p.kind === 'reasoning' || p.kind === 'tool_meta')
  if (debug.length === 0) return null
  return (
    <details className="mt-2 rounded-md border border-border-subtle bg-bg-secondary/50 px-3 py-2 text-xs text-text-muted">
      <summary className="cursor-pointer select-none font-mono text-text-muted">
        推理 / 工具调用（{debug.length}）
      </summary>
      <div className="mt-2 space-y-2">
        {debug.map((p, i) => (
          <div key={p.id ?? i} className="font-mono">
            <span className="text-accent-green/70">[{p.kind}]</span>{' '}
            <span className="whitespace-pre-wrap break-words">{p.text}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

export default function CoachChatMessage({
  role,
  content,
  refusal = false,
  parts,
  showDebug = false,
  toolName,
  eventStatus,
}: CoachChatMessageProps) {
  if (role === 'event') {
    // Trusted receipt: compact status bar, never markdown. `applied` reads as
    // a positive (green) confirmation; anything else (e.g. abandoned) is neutral.
    const applied = eventStatus === 'applied'
    return (
      <div
        data-role="event"
        data-status={eventStatus ?? ''}
        role="status"
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${
          applied
            ? 'border-accent-green/30 bg-accent-green/10 text-accent-green'
            : 'border-border-subtle bg-bg-secondary/60 text-text-muted'
        }`}
      >
        <span aria-hidden className="flex-shrink-0">
          {applied ? '✓' : '○'}
        </span>
        <span className="min-w-0 break-words">{content}</span>
      </div>
    )
  }

  if (role === 'user') {
    return (
      <div
        role="group"
        aria-label="你的消息"
        className="flex justify-end"
        data-role="user"
      >
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-lg rounded-tr-sm bg-accent-green/12 px-3.5 py-2 text-sm text-text-primary">
          {content}
        </div>
      </div>
    )
  }

  if (role === 'tool') {
    // Debug-only raw tool output, collapsed by default.
    return (
      <details
        data-role="tool"
        className="rounded-md border border-border-subtle bg-bg-secondary/50 px-3 py-2 text-xs text-text-muted"
      >
        <summary className="cursor-pointer select-none font-mono text-text-muted">
          工具输出{toolName ? ` · ${toolName}` : ''}
        </summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono">{content}</pre>
      </details>
    )
  }

  return (
    <div className="flex gap-2.5" data-role="coach">
      <CoachAvatar />
      <div className="min-w-0 flex-1">
        <article
          className={`prose max-w-none rounded-lg rounded-tl-sm border border-border-subtle bg-bg-card px-3.5 py-2 text-sm ${
            refusal ? 'text-text-muted' : 'text-text-primary'
          }`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        </article>
        {showDebug && parts ? <DebugParts parts={parts} /> : null}
      </div>
    </div>
  )
}
