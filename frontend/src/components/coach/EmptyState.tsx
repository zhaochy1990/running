interface EmptyStateProps {
  onPick: (prompt: string) => void
}

// Starter intents drawn from the product vision §9 intent table.
const SUGGESTIONS = [
  '我现在状态怎么样？',
  '帮我把这周强度提一点',
  '跟腱有点疼，怎么调整？',
  '推荐一双速度训练跑鞋',
]

export default function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-4">
      <div className="w-12 h-12 rounded-full bg-accent-green/15 grid place-items-center mb-4">
        <span className="text-accent-green text-lg font-bold font-mono">S</span>
      </div>
      <h2 className="text-lg font-semibold text-text-primary m-0">你的 AI 教练</h2>
      <p className="text-[13px] text-text-secondary mt-1.5 max-w-[420px]">
        问状态、调计划、聊伤病或装备 —— 一个对话框搞定。涉及改计划时，会先给提案，确认后才生效。
      </p>
      <div className="flex flex-wrap justify-center gap-2 mt-5 max-w-[520px]">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-full border border-border-subtle bg-bg-card px-3 py-1.5 text-[12px] text-text-secondary hover:border-accent-green/40 hover:text-text-primary transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
