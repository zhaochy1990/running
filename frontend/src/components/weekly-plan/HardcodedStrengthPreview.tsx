const TARGET_FOLDER = '2026-08-03_08-09'

interface Exercise {
  readonly name: string
  readonly prescription: string
  readonly imageUrl?: string
  readonly keyPoints: readonly string[]
  readonly muscleFocus: readonly string[]
  readonly commonMistakes: readonly string[]
}

interface Session {
  readonly date: string
  readonly title: string
  readonly focus: string
  readonly duration: string
  readonly exercises: readonly Exercise[]
}

const SESSIONS: readonly Session[] = [
  {
    date: '周一 · 8 月 3 日',
    title: '力量 A · 臀腿力量',
    focus: '轻中等强度，强化臀肌、股四头和腘绳肌；放在周一的慢跑之后完成',
    duration: '约 65 分钟',
    exercises: [
      {
        name: '徒手深蹲', prescription: '12次 * 3组', imageUrl: '/strength_illustrations/output/T1061/v1.png',
        keyPoints: ['髋部先后坐，膝盖跟随脚尖方向。', '起身时臀腿同步发力，脚跟始终踩实。'],
        muscleFocus: ['股四头肌', '臀大肌', '腘绳肌'],
        commonMistakes: ['膝盖内扣', '脚跟离地、重心压向脚尖'],
      },
      {
        name: '单腿硬拉抬膝', prescription: '每侧 8次 * 3组', imageUrl: '/strength_illustrations/output/T1144/v1.png',
        keyPoints: ['支撑腿微屈不锁膝，髋部后送时保持骨盆稳定。', '起身后将对侧膝抬至与地面平行，肚脐始终朝前。'],
        muscleFocus: ['臀大肌', '腘绳肌', '臀中肌'],
        commonMistakes: ['骨盆侧倾或旋转', '上身过度前倾，用腰部代偿'],
      },
      {
        name: '仰卧臀桥', prescription: '12次 * 3组', imageUrl: '/strength_illustrations/output/T1132/v1.png',
        keyPoints: ['双脚髋宽，顶端从膝到肩形成直线。', '顶端停 2 秒，感受臀部收紧。'],
        muscleFocus: ['臀大肌', '腘绳肌', '竖脊肌'],
        commonMistakes: ['用腰部过度挺起', '脚跟离臀过远导致腘绳肌代偿'],
      },
      {
        name: '保加利亚分腿蹲', prescription: '每侧 8次 * 3组', imageUrl: '/strength_illustrations/output/T1164/v1.png',
        keyPoints: ['前脚距离凳子约一腿长，重心落在前脚足中后部。', '后膝靠近地面，前膝沿脚尖方向运动。'],
        muscleFocus: ['股四头肌', '臀大肌', '核心稳定肌'],
        commonMistakes: ['前膝内扣', '前脚距离太近导致膝盖压力过大'],
      },
      {
        name: '单腿提踵', prescription: '每侧 12次 * 3组', imageUrl: '/strength_illustrations/output/T1275/v4.png',
        keyPoints: ['单脚站立，对侧腿轻抬保持平衡。', '顶端停留 1 秒，控制 2 秒离心下落。'],
        muscleFocus: ['腓肠肌', '比目鱼肌', '胫骨后肌'],
        commonMistakes: ['动作幅度不够', '脚踝外翻，重心压外侧'],
      },
      {
        name: '侧卧蚌式开合', prescription: '每侧 15次 * 3组', imageUrl: '/strength_illustrations/output/T1317/v1.png',
        keyPoints: ['骨盆保持叠放，脚跟并拢后打开上侧膝盖。', '动作幅度以骨盆不后翻为限。'],
        muscleFocus: ['臀中肌', '臀小肌', '髋外旋肌群'],
        commonMistakes: ['骨盆向后滚动代偿', '用腰部扭转带动膝盖'],
      },
    ],
  },
  {
    date: '周五 · 8 月 7 日',
    title: '力量 B · 核心与背部',
    focus: '强化躯干抗旋转与上背稳定；关键跑前保留余量，不做到力竭',
    duration: '约 60 分钟',
    exercises: [
      {
        name: '俯卧 I 字', prescription: '12次 * 3组', imageUrl: '/strength_illustrations/output/T1277/v1.png',
        keyPoints: ['俯卧后手臂向头顶方向伸直，拇指朝上。', '肩胛向后下收，缓慢抬起手臂，不耸肩。'],
        muscleFocus: ['下斜方肌', '菱形肌', '竖脊肌'],
        commonMistakes: ['耸肩代偿', '抬头或用腰部反弓完成动作'],
      },
      {
        name: '鸟狗平衡', prescription: '每侧 8次 * 3组', imageUrl: '/strength_illustrations/output/T1249/v1.png',
        keyPoints: ['对侧手脚伸直并与地面平行。', '肩与髋保持水平，停顿 2 秒再换边。'],
        muscleFocus: ['竖脊肌', '深层核心', '肩袖稳定肌'],
        commonMistakes: ['骨盆旋转', '抬腿过高造成腰椎代偿'],
      },
      {
        name: '平板支撑', prescription: '40秒 * 3组', imageUrl: '/strength_illustrations/output/T1010/v1.png',
        keyPoints: ['肘在肩正下方，脚跟到头部保持直线。', '主动收紧臀部与腹部，均匀呼吸。'],
        muscleFocus: ['腹横肌', '腹直肌', '肩稳定肌'],
        commonMistakes: ['塌腰', '臀部抬得过高'],
      },
      {
        name: '死虫式', prescription: '每侧 10次 * 3组', imageUrl: '/strength_illustrations/output/T1243/v3.png',
        keyPoints: ['腰背轻贴地面，对侧手脚缓慢伸展。', '呼气时收紧腹部，动作范围以腰不离地为准。'],
        muscleFocus: ['腹横肌', '腹直肌', '髂腰肌'],
        commonMistakes: ['腰椎离地', '为了幅度过快甩动手脚'],
      },
      {
        name: '侧平板支撑', prescription: '每侧 30秒 * 3组', imageUrl: '/strength_illustrations/output/T1185/v1.png',
        keyPoints: ['肘置于肩正下方，身体从脚踝到头部成一直线。', '主动抬高下侧髋部，均匀呼吸。'],
        muscleFocus: ['腹斜肌', '腰方肌', '臀中肌'],
        commonMistakes: ['塌腰或骨盆后翻', '支撑肩耸起压向耳朵'],
      },
      {
        name: '俯卧 Y 字', prescription: '12次 * 3组', imageUrl: '/strength_illustrations/output/T1278/v2.png',
        keyPoints: ['俯卧后将手臂呈 Y 字抬起，拇指朝上。', '由肩胛向后下收带动，颈部保持放松。'],
        muscleFocus: ['下斜方肌', '菱形肌', '三角肌后束'],
        commonMistakes: ['耸肩代偿', '抬头或用腰部反弓完成动作'],
      },
      {
        name: '单腿提踵', prescription: '每侧 12次 * 3组', imageUrl: '/strength_illustrations/output/T1275/v4.png',
        keyPoints: ['单脚站立，对侧腿轻抬保持平衡。', '顶端停留 1 秒，控制 2 秒离心下落。'],
        muscleFocus: ['腓肠肌', '比目鱼肌', '胫骨后肌'],
        commonMistakes: ['动作幅度不够', '脚踝外翻，重心压外侧'],
      },
    ],
  },
]

export function hasHardcodedStrengthPreview(folder: string | undefined): boolean {
  return folder === TARGET_FOLDER
}

export default function HardcodedStrengthPreview() {
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-accent-purple/30 bg-bg-card p-5 shadow-sm sm:p-6">
        <p className="text-xs font-bold uppercase tracking-wider text-accent-purple">本周补充 · 力量训练</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold text-text-primary">2 节跑者力量维护</h2>
            <p className="mt-2 text-sm text-text-muted">一节强化臀腿力量，一节强化核心与背部稳定，服务本周跑步训练。</p>
          </div>
          <span className="rounded-full bg-purple-soft px-3 py-1 font-mono text-xs font-bold text-accent-purple">约 125 分钟</span>
        </div>
      </section>

      <div className="space-y-4">
        {SESSIONS.map((session, index) => <StrengthSessionCard key={session.title} session={session} index={index} initiallyExpanded={index === 0} />)}
      </div>

      <p className="rounded-xl border border-accent-amber/30 bg-amber-soft px-4 py-3 text-xs leading-5 text-text-secondary">
        疲劳调整：下肢酸痛、跟腱或小腿不适时，减少每个下肢动作 1 组，仅完成核心动作。
      </p>
    </div>
  )
}

function StrengthSessionCard({ session, index, initiallyExpanded }: { session: Session; index: number; initiallyExpanded: boolean }) {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const panelId = `strength-session-${index}`

  return (
    <article className="rounded-2xl border border-border-subtle bg-bg-card shadow-sm">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-4 p-5 text-left transition-colors hover:bg-bg-card-hover"
      >
        <div>
          <p className="font-mono text-xs text-accent-purple">{session.date}</p>
          <h3 className="mt-2 text-lg font-bold text-text-primary">{session.title}</h3>
          <p className="mt-1 text-xs text-text-muted">{session.focus}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden font-mono text-xs text-text-muted sm:inline">{session.duration}</span>
          <span className="text-lg leading-none text-text-muted" aria-hidden="true">{expanded ? '−' : '+'}</span>
        </div>
      </button>
      {expanded && (
        <div id={panelId} className="border-t border-border-subtle px-5 pb-5 pt-4">
          <div className="space-y-2">
            {session.exercises.map((exercise) => (
              <div key={exercise.name} className="rounded-xl bg-bg-secondary p-3">
                <p className="text-sm font-semibold text-text-primary">{exercise.name} <span className="whitespace-nowrap font-mono text-xs text-accent-purple">{exercise.prescription}</span></p>
                <div className={`mt-3 ${exercise.imageUrl ? 'grid gap-10 md:grid-cols-[minmax(0,280px)_1fr] md:items-start' : ''}`}>
                  {exercise.imageUrl && (
                    <img src={exercise.imageUrl} alt={`${exercise.name} 动作示意图`} loading="lazy" className="mx-auto w-full max-w-sm rounded-lg border border-border-subtle bg-white md:max-w-[280px]" />
                  )}
                  <div>
                    <DetailBlock title="动作要点" items={exercise.keyPoints} />
                    <DetailBlock title="发力部位" items={exercise.muscleFocus} inline />
                    <DetailBlock title="常见错误" items={exercise.commonMistakes} error />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  )
}

function DetailBlock({ title, items, inline = false, error = false }: { title: string; items: readonly string[]; inline?: boolean; error?: boolean }) {
  return (
    <div className="mt-3">
      <p className={`text-xs font-mono tracking-wider ${error ? 'text-accent-red' : 'text-text-secondary'}`}>{title}</p>
      {inline ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {items.map((item) => <span key={item} className="rounded bg-accent-cyan/10 px-2 py-1 text-sm font-mono text-accent-cyan">{item}</span>)}
        </div>
      ) : (
        <ul className="mt-1.5 list-disc space-y-1.5 pl-5 text-sm leading-6 text-text-muted">
          {items.map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
    </div>
  )
}
import { useState } from 'react'
