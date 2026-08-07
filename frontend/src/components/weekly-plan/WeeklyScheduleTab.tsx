import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatDateShort, weekdayCN, type PlanDay, type WeekDetail } from '../../api'
import { formatSessionLoad, sessionTarget, weeklyPlanStats } from '../../lib/weeklyPlanView'
import type { PlannedNutrition, PlannedSession, StructuredStatus } from '../../types/plan'
import PushAllPlannedButton from '../PushAllPlannedButton'
import PushPlannedButton from '../PushPlannedButton'
import CoachWeeklyPlanEmptyState from './CoachWeeklyPlanEmptyState'

export interface WeeklyScheduleTabProps {
  readonly week: WeekDetail
  readonly days: readonly PlanDay[]
  readonly structuredStatus: StructuredStatus
  readonly canPushRun: boolean
  readonly canPushStrength: boolean
  readonly onPush: (session: PlannedSession, targetDate?: string) => Promise<void>
}

const KIND_LABEL: Record<PlannedSession['kind'], string> = {
  run: '跑步',
  strength: '力量',
  rest: '休息',
  cross: '交叉训练',
  note: '说明',
}

const KIND_STYLE: Record<PlannedSession['kind'], string> = {
  run: 'bg-green-soft text-accent-green',
  strength: 'bg-purple-soft text-accent-purple',
  rest: 'bg-bg-secondary text-text-muted',
  cross: 'bg-cyan-soft text-accent-cyan',
  note: 'bg-amber-soft text-accent-amber',
}

const HARDCODED_STRENGTH_FOLDER = '2026-08-03_08-09'

function session(date: string, sessionIndex: number, kind: PlannedSession['kind'], summary: string, durationS: number | null, distanceM: number | null, notesMd: string): PlanDay['sessions'][number] {
  return { id: sessionIndex, pushable: false, schema: 'plan-session/v1', date, session_index: sessionIndex, kind, summary, spec: null, notes_md: notesMd, total_duration_s: durationS, total_distance_m: distanceM, scheduled_workout_id: null }
}

function nutrition(date: string, kcal: number, carbs: number, protein: number, water: number, notesMd: string): PlannedNutrition {
  return { schema: 'plan-nutrition/v1', date, kcal_target: kcal, carbs_g: carbs, protein_g: protein, fat_g: null, water_ml: water, meals: [], notes_md: notesMd }
}

export function hardcodedWeekDays(folder: string, apiDays: readonly PlanDay[]): readonly PlanDay[] | null {
  if (folder !== HARDCODED_STRENGTH_FOLDER) return null
  const fixedDays: readonly PlanDay[] = [
    { date: '2026-08-03', sessions: [session('2026-08-03', 0, 'run', '慢跑 12K', 66 * 60, 12000, '建议配速 5:30/km；全程轻松可交谈，控制在 Z2，结束后做 5–10 分钟放松。'), session('2026-08-03', 1, 'strength', '力量 A · 臀腿力量', 65 * 60, null, '放在周一的慢跑之后完成；包含深蹲、单腿硬拉、臀桥、分腿蹲、小腿与髋稳定训练。')], nutrition: nutrition('2026-08-03', 2800, 350, 140, 3500, '跑后先补碳水；力量训练结束后 1 小时内补充 30–35 g 蛋白质。') },
    { date: '2026-08-04', sessions: [session('2026-08-04', 0, 'run', '间歇训练 · (400 快 + 400 慢 + 400 快) × 8 组', null, 9600, '训练目的：提高心肺耐力与节奏控制。\n热身慢跑：15–20 分钟轻松跑。\n热身内容：胫骨拉伸、抱提膝、动态弓箭步、动态侧弓步、原地小跳、直腿跑、马克 A、小步跑、后踢腿。\n主训练：400m 快 @ 3:30–3:40/km + 400m 慢 @ 4:50–5:00/km + 400m 快 @ 3:25–3:35/km，共 8 组。\n训练后拉伸：胫骨拉伸、最伟大拉伸、股四头肌拉伸、侧弓步拉伸、臀部拉伸、阔筋膜张肌拉伸、上肢拉伸。')], nutrition: nutrition('2026-08-04', 3000, 420, 140, 4000, '训练前 2–3 小时补充易消化碳水；训练后优先补碳水与 30 g 蛋白质。') },
    { date: '2026-08-05', sessions: [session('2026-08-05', 0, 'run', '恢复跑 6–8K', null, null, '低强度恢复，按体感选择 6–8K；腿部沉重时缩短距离。')], nutrition: nutrition('2026-08-05', 2500, 280, 130, 3000, '跑后补充一份碳水 + 蛋白质加餐，全天均匀补水。') },
    { date: '2026-08-08', sessions: [session('2026-08-08', 0, 'run', '长距离跑 28K', 2 * 3600 + 14 * 60 + 35, 28000, '训练目的：提高有氧基础。\n热身内容：胫骨拉伸、抱提膝、动态弓箭步、动态侧弓步、原地小跳、直腿跑、马克 A、小步跑、后踢腿。\n训练后拉伸：胫骨拉伸、最伟大拉伸、股四头肌拉伸、侧弓步拉伸、臀部拉伸、阔筋膜张肌拉伸、上肢拉伸。\n训练说明：分段执行：0–5km @ 5:00/km；5–10km @ 4:55/km；10–15km @ 4:50/km；15–20km @ 4:45/km；20–25km @ 4:40/km；25–28km @ 4:35/km。预计总用时约 2:14:35。渐加速指每段配速比前一段快 5秒/km。前段严格克制，后段以动作稳定为先；若出现疼痛、动作变形或 RPE 达到 8，停止提速并按轻松强度完成或提前结束。长距离中同步练习补水与能量胶补给。')], nutrition: nutrition('2026-08-08', 3300, 480, 140, 4500, '跑前 2–3 小时补充 70–140 g 碳水；跑中每小时 30–60 g 能量胶、饮水 400–800 ml，搭配盐丸和电解质饮料；跑后 1 小时内补充碳水 70–85 g + 蛋白质 25–30 g。') },
  ]
  const fixedDaysByDate = new Map(fixedDays.map((day) => [day.date, day]))
  return apiDays.map((day) => {
    const fixedDay = fixedDaysByDate.get(day.date)
    if (fixedDay) return fixedDay
    if (day.date === '2026-08-06') {
      return {
        ...day,
        nutrition: nutrition('2026-08-06', 2900, 400, 135, 3800, '混氧跑前 2–3 小时补充易消化碳水；训练后补充碳水与 30 g 蛋白质，分次补水。'),
      }
    }
    if (day.date === '2026-08-07') {
      return {
        ...day,
        sessions: [
          ...day.sessions.filter((session) => session.kind !== 'strength'),
          session('2026-08-07', 100, 'strength', '力量 B · 核心与背部', 60 * 60, null, '强化上背、核心抗伸展与抗旋转；包含俯卧 I/Y 字、鸟狗、平板、死虫与侧平板。'),
        ],
        nutrition: nutrition('2026-08-07', 2800, 380, 140, 3500, '为周六长距离储备糖原；力量训练后 1 小时内补充 30–35 g 蛋白质。'),
      }
    }
    if (day.date === '2026-08-09') {
      return {
        ...day,
        nutrition: nutrition('2026-08-09', 2600, 320, 130, 3200, '跑前后均衡补充碳水与蛋白质；优先补液、电解质与睡眠恢复。'),
      }
    }
    return day
  })
}

export default function WeeklyScheduleTab({
  week,
  days,
  structuredStatus,
  canPushRun,
  canPushStrength,
  onPush,
}: WeeklyScheduleTabProps) {
  if (days.length === 0 && !week.plan?.trim()) return <CoachWeeklyPlanEmptyState />

  if (days.length === 0) {
    return <div className="prose rounded-2xl border border-border-subtle bg-bg-card p-6"><ReactMarkdown remarkPlugins={[remarkGfm]}>{week.plan}</ReactMarkdown></div>
  }

  const displayDays = hardcodedWeekDays(week.folder, days) ?? days
  const stats = weeklyPlanStats(displayDays)
  return (
    <div className="space-y-4">
      <PushAllPlannedButton
        sessions={stats.sessions}
        structuredStatus={structuredStatus}
        canPushRun={canPushRun}
        canPushStrength={canPushStrength}
        onPush={(session) => onPush(session)}
      />

      <div>
        <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card shadow-sm" aria-label="本周训练课表">
          {displayDays.map((day) => {
            return (
            <article key={day.date} className="grid gap-4 border-b border-border-subtle p-4 last:border-b-0 sm:grid-cols-[78px_minmax(0,1fr)] sm:p-5">
              <div className="border-border-subtle sm:border-r">
                <p className="text-xs font-bold uppercase text-text-muted">{weekdayCN(day.date)}</p>
                <p className="mt-1 font-mono text-lg font-bold text-text-primary">{formatDateShort(day.date).replace('月', '/').replace('日', '')}</p>
              </div>
              <div className="space-y-3">
                {day.sessions.length === 0 ? (
                  <div className="rounded-xl bg-bg-secondary px-4 py-3 text-sm text-text-muted">无训练安排</div>
                ) : day.sessions.map((session) => (
                  <SessionRow
                    key={session.session_index}
                    session={session}
                    structuredStatus={structuredStatus}
                    canPushRun={canPushRun}
                    canPushStrength={canPushStrength}
                    onPush={onPush}
                    hidePush={week.folder === HARDCODED_STRENGTH_FOLDER && day.date !== '2026-08-06' && day.date !== '2026-08-09'}
                  />
                ))}
                {day.nutrition && <NutritionLine nutrition={day.nutrition} />}
              </div>
            </article>
            )
          })}
        </section>
      </div>
    </div>
  )
}

interface SessionRowProps {
  readonly session: PlannedSession
  readonly structuredStatus: StructuredStatus
  readonly canPushRun: boolean
  readonly canPushStrength: boolean
  readonly onPush: (session: PlannedSession, targetDate?: string) => Promise<void>
  readonly hidePush?: boolean
}

function SessionRow({ session, structuredStatus, canPushRun, canPushStrength, onPush, hidePush = false }: SessionRowProps) {
  const target = sessionTarget(session)
  const quality = session.kind === 'run' && /interval|tempo|threshold|vo2|max|间歇|节奏|阈值/i.test(`${session.summary} ${session.notes_md ?? ''}`)
  return (
    <div className="grid gap-3 rounded-xl border border-border-subtle p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2.5 py-1 text-xs font-bold ${KIND_STYLE[session.kind]}`}>{KIND_LABEL[session.kind]}</span>
          {quality && <span className="rounded bg-red-soft px-2.5 py-1 text-xs font-bold text-accent-red">Quality</span>}
          <h2 className="text-base font-bold text-text-primary">{session.summary}</h2>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm text-text-muted">
          <span>{formatSessionLoad(session)}</span>
          {target && <span>{target}</span>}
        </div>
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-text-secondary">{session.notes_md || session.spec?.note || '按计划执行，并根据当日恢复状态保持动作与配速质量。'}</p>
      </div>
      {!hidePush && <div className="self-start">
        <PushPlannedButton session={session} structuredStatus={structuredStatus} canPushRun={canPushRun} canPushStrength={canPushStrength} onPush={(current, date) => onPush(current, date)} />
      </div>}
    </div>
  )
}

interface NutritionLineProps {
  readonly nutrition: PlannedNutrition
}

function NutritionLine({ nutrition }: NutritionLineProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-subtle pt-3 text-sm text-text-muted">
      <span className="rounded bg-green-soft px-2.5 py-1 font-bold text-accent-green">营养摄入</span>
      {nutrition.kcal_target != null && <span className="font-mono">{Math.round(nutrition.kcal_target)} kcal</span>}
      {nutrition.carbs_g != null && <span className="font-mono">碳水目标 {Math.round(nutrition.carbs_g)} g</span>}
      {nutrition.protein_g != null && <span className="font-mono font-semibold text-accent-green">蛋白质目标 {Math.round(nutrition.protein_g)} g</span>}
      {nutrition.water_ml != null && <span className="font-mono">补水 {Math.round(nutrition.water_ml)} ml</span>}
      {nutrition.notes_md && <span className="leading-6">{nutrition.notes_md}</span>}
    </div>
  )
}
