import { useEffect, useState, type FormEvent } from 'react'

export interface WeeklyFeedbackTabProps {
  readonly initialValue: string
  readonly onSave: (content: string) => Promise<void>
}

export default function WeeklyFeedbackTab({ initialValue, onSave }: WeeklyFeedbackTabProps) {
  const [content, setContent] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => setContent(initialValue), [initialValue])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setSaved(false)
    try { await onSave(content); setSaved(true) } finally { setSaving(false) }
  }

  return (
    <form onSubmit={submit} className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <section className="rounded-2xl border border-border-subtle bg-bg-card p-6">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-wider text-text-muted">本周反馈</p><h2 className="mt-1 text-2xl font-bold text-text-primary">告诉 Coach 真实体感</h2></div><button disabled={saving} className="rounded-lg bg-accent-green px-4 py-2 text-sm font-bold text-white disabled:opacity-60">{saving ? '保存中…' : '保存反馈'}</button></div>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} className="mt-5 min-h-72 w-full resize-y rounded-xl border border-border bg-bg-secondary p-4 font-mono text-sm text-text-primary outline-none focus:border-accent-green" placeholder={'- 关键课 RPE（1-10）\n- 腿部、呼吸和疼痛体感\n- 睡眠与恢复\n- 希望 Coach 下周如何调整'} />
        {saved && <p className="mt-3 text-xs text-accent-green">反馈已保存，Coach 后续生成计划时会参考。</p>}
      </section>
      <aside className="rounded-2xl border border-border-subtle bg-bg-card p-5"><h3 className="text-sm font-bold text-text-primary">建议补充</h3><ul className="mt-4 space-y-3 text-sm leading-6 text-text-secondary"><li>关键课完成度与 RPE</li><li>疼痛位置和持续时间</li><li>睡眠、HRV 与腿部疲劳</li><li>营养和补水执行情况</li></ul></aside>
    </form>
  )
}
