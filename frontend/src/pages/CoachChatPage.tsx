/**
 * CoachChatPage — the two-column daily coach Q&A page (left sidebar is the
 * shared AppLayout). It is a thin wrapper around the reusable `CoachChat`
 * conversation panel: page header + chrome, then the chat. The same `CoachChat`
 * node is reused by the plan-adjust workspace's right column.
 */
import CoachChat from '../components/CoachChat'

export default function CoachChatPage() {
  return (
    <div
      data-testid="coach-chat-page"
      className="flex h-full w-full max-w-none flex-col py-6"
    >
      <header className="flex-shrink-0 px-4 sm:px-8 lg:px-10 xl:px-12">
        <h1 className="text-lg font-bold tracking-tight text-text-primary">STRIDE Coach</h1>
        <p className="mt-1 text-sm text-text-muted">
          向 Coach 提问、请求解释或复盘；对话可以引用计划，但不会直接改变计划。
        </p>
      </header>
      <div className="mt-4 min-h-0 flex-1">
        <CoachChat edgeToEdge />
      </div>
    </div>
  )
}
