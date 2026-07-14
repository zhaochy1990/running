import { useEffect, useState, type FormEvent } from 'react'
import { weekdayCN, type PlanDay } from '../../api'
import { formatSessionLoad, sessionTarget, weeklyPlanStats } from '../../lib/weeklyPlanView'

export interface WeeklyFeedbackTabProps {
  readonly initialValue: string
  readonly days: readonly PlanDay[]
  readonly onSave: (content: string) => Promise<void>
}

const QUICK_TAGS = ['关键课偏重', '小腿紧', '双 session 可接受', '长跑补给不足', '希望调整下一周'] as const

export default function WeeklyFeedbackTab({ initialValue, days, onSave }: WeeklyFeedbackTabProps) {
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

  const appendTag = (tag: string) => {
    setSaved(false)
    setContent((current) => current.trim() ? `${current.trim()}\n- ${tag}` : `- ${tag}`)
  }
  const stats = weeklyPlanStats(days)
  const keySessions = stats.sessions
    .filter((session) => session.kind === 'run')
    .sort((left, right) => feedbackPriority(right) - feedbackPriority(left))
    .slice(0, 3)

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-wider text-text-muted">本周反馈</p><h2 className="mt-1 text-2xl font-bold text-text-primary">围绕本周关键课记录体感</h2><p className="mt-2 text-sm text-text-muted">完整记录 RPE、腿部反应、恢复和营养执行，供 Coach 生成后续计划时参考。</p></div><button disabled={saving} className="rounded-lg bg-accent-green px-4 py-2 text-sm font-bold text-white disabled:opacity-60">{saving ? '保存中…' : '保存反馈'}</button></div>
          <textarea value={content} onChange={(event) => { setContent(event.target.value); setSaved(false) }} className="mt-5 min-h-72 w-full resize-y rounded-xl border border-border bg-bg-secondary p-4 font-mono text-sm text-text-primary outline-none focus:border-accent-green" placeholder={'- 关键课 RPE（1-10）与完成质量\n- 腿部、呼吸和疼痛体感\n- 睡眠、HRV 与恢复\n- 营养和补水是否按计划执行\n- 希望 Coach 下周如何调整'} />
          <div className="mt-3 flex items-center justify-between text-xs text-text-muted"><span>首页用于快速记录；这里用于完整反馈。</span>{saved && <span className="font-bold text-accent-green">反馈已保存</span>}</div>
        </section>
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm"><h3 className="text-sm font-bold text-text-primary">建议记录节点</h3><div className="mt-4 space-y-3">{keySessions.length === 0 ? <p className="text-sm text-text-muted">计划结构化后会在这里显示关键训练节点。</p> : keySessions.map((session, index) => <div key={`${session.date}-${session.session_index}`} className="rounded-xl border border-border-subtle p-4"><div className="flex flex-wrap justify-between gap-2"><p className="text-sm font-bold text-text-primary">{weekdayCN(session.date)} · {session.summary}</p><span className="text-[10px] font-bold text-accent-amber">{index === 0 ? '关键反馈' : '恢复反馈'}</span></div><p className="mt-2 text-xs leading-5 text-text-secondary">计划 {formatSessionLoad(session)}{sessionTarget(session) ? ` · ${sessionTarget(session)}` : ''}。记录完成质量、RPE、疼痛、补给和次日恢复。</p></div>)}</div></section>
      </div>
      <aside className="space-y-4">
        <div className="rounded-xl border border-border-subtle bg-bg-card p-5 shadow-sm"><h3 className="text-sm font-bold text-text-primary">快速标签</h3><div className="mt-4 flex flex-wrap gap-2">{QUICK_TAGS.map((tag) => <button key={tag} type="button" onClick={() => appendTag(tag)} className="rounded-full bg-bg-secondary px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-green-soft hover:text-accent-green">{tag}</button>)}</div></div>
        <div className="rounded-xl border border-border-subtle bg-bg-card p-5 shadow-sm"><h3 className="text-sm font-bold text-text-primary">建议补充</h3><ul className="mt-4 space-y-3 text-sm leading-6 text-text-secondary"><li>RPE 1–10 分</li><li>疼痛位置和持续时间</li><li>睡眠、HRV 与腿部疲劳</li><li>营养日是否按目标执行</li></ul></div>
        <div className="rounded-xl border border-accent-amber/30 bg-amber-soft p-5"><h3 className="text-sm font-bold text-accent-amber">会触发调整的反馈</h3><p className="mt-2 text-xs leading-5 text-text-secondary">连续腿沉、疼痛、关键课无法完成或长距离恢复异常，都应明确写入反馈。</p></div>
      </aside>
    </form>
  )
}

function feedbackPriority(session: (ReturnType<typeof weeklyPlanStats>)['sessions'][number]): number {
  const quality = /interval|tempo|threshold|vo2|max|间歇|节奏|阈值/i.test(`${session.summary} ${session.notes_md ?? ''}`)
  return (quality ? 1_000_000 : 0) + (session.total_distance_m ?? 0)
}
