/**
 * CoachChatPage — the two-column daily coach Q&A page (left sidebar is the
 * shared AppLayout). It is a thin wrapper around the reusable `CoachChat`
 * conversation panel: page header + chrome, then the chat. The same `CoachChat`
 * node is reused by the plan-adjust workspace's right column.
 */
import CoachChat from '../components/CoachChat'

export default function CoachChatPage() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-4 py-6 sm:px-8">
      <header className="flex-shrink-0">
        <h1 className="text-lg font-bold tracking-tight text-text-primary">Coach 问答</h1>
        <p className="mt-1 text-sm text-text-muted">
          向 Coach 提问、请求解释或复盘；对话可以引用计划，但不会直接改变计划。
        </p>
      </header>
      <div className="mt-4 min-h-0 flex-1">
        <CoachChat />
      </div>
    </div>
  )
}
