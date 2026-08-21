import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatDateShort, weekdayCN, type PlanDay, type WeekDetail } from "../../api";
import { formatSessionLoad, sessionTarget, weeklyPlanStats } from "../../lib/weeklyPlanView";
import type { PlannedNutrition, PlannedSession, StructuredStatus } from "../../types/plan";
import PushAllPlannedButton from "../PushAllPlannedButton";
import PushPlannedButton from "../PushPlannedButton";
import CoachWeeklyPlanEmptyState from "./CoachWeeklyPlanEmptyState";

export interface WeeklyScheduleTabProps {
  readonly week: WeekDetail;
  readonly days: readonly PlanDay[];
  readonly structuredStatus: StructuredStatus;
  readonly canPushRun: boolean;
  readonly canPushStrength: boolean;
  readonly onPush: (session: PlannedSession, targetDate?: string) => Promise<void>;
}

const KIND_LABEL: Record<PlannedSession["kind"], string> = {
  run: "跑步",
  strength: "力量",
  rest: "休息",
  cross: "交叉训练",
  note: "说明",
};

const KIND_STYLE: Record<PlannedSession["kind"], string> = {
  run: "bg-green-soft text-accent-green",
  strength: "bg-purple-soft text-accent-purple",
  rest: "bg-bg-secondary text-text-muted",
  cross: "bg-cyan-soft text-accent-cyan",
  note: "bg-amber-soft text-accent-amber",
};



export default function WeeklyScheduleTab({ week, days, structuredStatus, canPushRun, canPushStrength, onPush }: WeeklyScheduleTabProps) {
  if (days.length === 0 && !week.plan?.trim()) return <CoachWeeklyPlanEmptyState />;

  if (days.length === 0) {
    return (
      <div className="prose rounded-2xl border border-border-subtle bg-bg-card p-6">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{week.plan}</ReactMarkdown>
      </div>
    );
  }

  const displayDays = days;
  const stats = weeklyPlanStats(displayDays);
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
                  <p className="mt-1 font-mono text-lg font-bold text-text-primary">{formatDateShort(day.date).replace("月", "/").replace("日", "")}</p>
                </div>
                <div className="space-y-3">
                  {day.sessions.length === 0 ? (
                    <div className="rounded-xl bg-bg-secondary px-4 py-3 text-sm text-text-muted">无训练安排</div>
                  ) : (
                    day.sessions.map((session) => (
                      <SessionRow
                        key={session.session_index}
                        session={session}
                        structuredStatus={structuredStatus}
                        canPushRun={canPushRun}
                        canPushStrength={canPushStrength}
                        onPush={onPush}
                        hidePush={false}
                      />
                    ))
                  )}
                  {day.nutrition && <NutritionLine nutrition={day.nutrition} />}
                </div>
              </article>
            );
          })}
        </section>
      </div>
    </div>
  );
}

interface SessionRowProps {
  readonly session: PlannedSession;
  readonly structuredStatus: StructuredStatus;
  readonly canPushRun: boolean;
  readonly canPushStrength: boolean;
  readonly onPush: (session: PlannedSession, targetDate?: string) => Promise<void>;
  readonly hidePush?: boolean;
}

function SessionRow({ session, structuredStatus, canPushRun, canPushStrength, onPush, hidePush = false }: SessionRowProps) {
  const target = sessionTarget(session);
  const quality = session.kind === "run" && /interval|tempo|threshold|vo2|max|间歇|节奏|阈值/i.test(`${session.summary} ${session.notes_md ?? ""}`);
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
        <p className="mt-2 whitespace-pre-line text-sm leading-6 text-text-secondary">
          {session.notes_md || session.spec?.note || "按计划执行，并根据当日恢复状态保持动作与配速质量。"}
        </p>
      </div>
      {!hidePush && (
        <div className="self-start">
          <PushPlannedButton
            session={session}
            structuredStatus={structuredStatus}
            canPushRun={canPushRun}
            canPushStrength={canPushStrength}
            onPush={(current, date) => onPush(current, date)}
          />
        </div>
      )}
    </div>
  );
}

interface NutritionLineProps {
  readonly nutrition: PlannedNutrition;
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
  );
}
