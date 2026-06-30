import { useState, type KeyboardEvent } from 'react'
import { SendIcon } from './CoachIcons'

interface ComposerProps {
  onSend: (message: string) => void
  disabled?: boolean
  placeholder?: string
}

/** Bottom-pinned message input. Enter sends; Shift+Enter inserts a newline. */
export default function Composer({ onSend, disabled, placeholder }: ComposerProps) {
  const [value, setValue] = useState('')

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setValue('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div>
      <div className="flex items-end gap-2 rounded-xl border border-border bg-bg-card p-2 focus-within:border-accent-green/50 transition-colors">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder ?? '问问你的教练，或说出你的诉求…'}
          className="flex-1 resize-none bg-transparent text-[13px] text-text-primary placeholder:text-text-muted outline-none max-h-32 py-1.5 px-1.5"
          aria-label="给教练的消息"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label="发送"
          className="w-9 h-9 flex-shrink-0 rounded-lg bg-accent-green text-white grid place-items-center hover:bg-accent-green-dim disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <SendIcon />
        </button>
      </div>
      <p className="font-mono text-[9px] text-text-muted tracking-wide mt-1.5 px-1">Enter 发送 · Shift+Enter 换行</p>
    </div>
  )
}
