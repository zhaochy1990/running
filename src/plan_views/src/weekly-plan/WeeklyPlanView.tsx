import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  actualRunKm,
  buildPlanDays,
  formatDateShort,
  formatDurationClock,
  formatEstimatedDose,
  formatSessionLoad,
  formatWeekRange,
  intensityBreakdown,
  sessionTarget,
  sportName,
  strengthActivityStats,
  weekdayCN,
  weeklyStats,
} from "../lib/weeklyPlanView";
import type { PlanDay, PlannedSession, WeeklyActivity, WeeklyPlanEnvelope } from "../types";
import { Empty, InfoCard, kindLabel, kindStyle, Metric, MetricSmall, QualityCard, type WeeklyPlanActions } from "./parts";

type ViewTab = "schedule" | "strength" | "records" | "feedback";

const TABS: Array<{ id: ViewTab; label: string }> = [
  { id: "schedule", label: "本周训练课表" },
  { id: "strength", label: "本周力量训练" },
  { id: "records", label: "本周训练记录" },
  { id: "feedback", label: "本周反馈" },
];

export interface WeeklyPlanViewProps {
  plan: WeeklyPlanEnvelope;
  week: {
    date_from: string;
    date_to: string;
    activity_count: number;
    total_duration_fmt: string;
    activities: WeeklyActivity[];
    feedback: string;
    feedback_created_at: string | null;
    feedback_updated_at: string | null;
    plan: string | null;
  };
  actions?: WeeklyPlanActions;
}

export function WeeklyPlanView({ plan, week, actions }: WeeklyPlanViewProps) {
  const [tab, setTab] = useState<ViewTab>("schedule");
  const structured = plan.content_version === 2 ? plan.content : null;
  const days = useMemo(() => (structured ? buildPlanDays(structured) : []), [structured]);
  const stats = weeklyStats(days);
  const strengthCount = stats.strengthCount;
  const readonly = !actions?.onAdjust && !actions?.onPushAll && !actions?.onSaveFeedback;

  return (
    <div className="master-plan-surface mx-auto max-w-[1180px] animate-fade-in space-y-6">
      <WeeklySummary plan={plan} week={week} days={days} actions={actions} />
      <div className="flex items-end gap-6 overflow-x-auto border-b border-border-subtle" role="tablist" aria-label="本周计划视图">
        {TABS.map((item) => {
          const count = item.id === "strength" ? strengthCount : item.id === "records" ? week.activity_count : null;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={"weekly-plan-tab-" + item.id}
              aria-controls="weekly-plan-tabpanel"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={
                "pb-3 text-sm whitespace-nowrap border-b-2 transition-colors " +
                (tab === item.id ? "font-bold text-accent-green border-accent-green" : "font-medium text-text-muted border-transparent hover:text-text-primary")
              }
            >
              {item.label}
              {count !== null && <span className="ml-1.5 rounded-full bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">{count}</span>}
            </button>
          );
        })}
      </div>
      <div id="weekly-plan-tabpanel" role="tabpanel" className="animate-fade-in">
        {tab === "schedule" && <ScheduleTab plan={plan} week={week} days={days} actions={actions} />}
        {tab === "strength" && <StrengthTab days={days} />}
        {tab === "records" && <RecordsTab days={days} activities={week.activities} />}
        {tab === "feedback" && <FeedbackTab days={days} feedback={week.feedback} updatedAt={week.feedback_updated_at} actions={actions} />}
      </div>
      {readonly && <p className="text-center font-mono text-[11px] text-text-muted">只读预览</p>}
    </div>
  );
}

function WeeklySummary({
  plan,
  week,
  days,
  actions,
}: {
  plan: WeeklyPlanEnvelope;
  week: WeeklyPlanViewProps["week"];
  days: PlanDay[];
  actions?: WeeklyPlanActions;
}) {
  const stats = weeklyStats(days);
  const intensity = intensityBreakdown(stats.sessions);
  const actualKm = actualRunKm(week.activities);
  const actualStrength = strengthActivityStats(week.activities);
  const completion = stats.plannedRunKm > 0 ? Math.min(100, Math.round((actualKm / stats.plannedRunKm) * 100)) : 0;
  const notes = plan.content_version === 2 ? plan.content.coach_notes?.trim() || plan.content.notes_md?.trim() : null;
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-accent-green">Coach Agent · Weekly Plan</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-text-primary">本周课表</h1>
          <p className="mt-2 text-sm text-text-muted">{formatWeekRange(week.date_from, week.date_to)}</p>
        </div>
        <div className="flex items-center gap-3">
          <MetricSmall label="实际跑量" value={actualKm.toFixed(1) + " km"} />
          <MetricSmall label="完成度" value={completion + "%"} />
          {actions?.onAdjust && (
            <button
              type="button"
              onClick={actions.onAdjust}
              className="rounded-lg border border-border-subtle bg-bg-secondary px-4 py-2.5 text-sm font-bold text-text-secondary transition hover:border-accent-green/40 hover:text-accent-green"
            >
              调整
            </button>
          )}
          <span className="rounded-lg border border-green-edge bg-green-soft px-4 py-2.5 text-sm font-bold text-accent-green">只读预览</span>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-wider text-accent-green">本周训练结构</p>
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="计划跑量" value={stats.plannedRunKm.toFixed(1) + " km"} accent />
            <Metric label="低强度 Z1+Z2" value={intensity.low.toFixed(1) + " km"} accent />
            <Metric label="Z3" value={intensity.mid.toFixed(1) + " km"} accent />
            <Metric label="高强度 Z4+Z5" value={intensity.high.toFixed(1) + " km"} accent />
            <Metric label="训练课" value={String(stats.sessions.length)} />
            <Metric label="跑步课" value={String(stats.runCount)} />
            <Metric label="力量课" value={String(stats.strengthCount)} />
            <Metric label="营养日" value={String(stats.nutritionDays)} />
            <Metric label="预计训练负荷" value={stats.estimatedLoad.toFixed(1) + " PMC"} accent />
          </div>
        </div>
        <aside className="rounded-2xl border border-green-edge bg-green-soft p-5">
          <p className="text-xs font-bold uppercase tracking-wider text-accent-green">本周训练重点</p>
          <p className="mt-3 text-lg font-bold leading-7 text-text-primary">
            {stats.runCount} 次跑步 + {stats.strengthCount} 次力量维护
          </p>
          <p className="mt-3 font-editorial text-sm italic leading-6 text-text-secondary">“{notes || "优先完成关键课，其余训练按恢复状态灵活降级。"}”</p>
          <div className="mt-4 space-y-1 border-t border-green-edge pt-3 text-xs text-text-secondary">
            <p>
              实际完成 {week.activity_count} 次 · 跑步 {actualKm.toFixed(1)} km · {week.total_duration_fmt}
            </p>
            <p>
              力量训练 {actualStrength.count} 次 · {formatDurationClock(actualStrength.durationS)}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function PushButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-lg border border-accent-green/40 bg-bg-card px-2.5 py-1 text-[11px] font-semibold text-accent-green transition hover:bg-green-soft"
    >
      {label}
    </button>
  );
}

function ScheduleTab({
  plan,
  week,
  days,
  actions,
}: {
  plan: WeeklyPlanEnvelope;
  week: WeeklyPlanViewProps["week"];
  days: PlanDay[];
  actions?: WeeklyPlanActions;
}) {
  if (plan.content_version === 1) {
    return (
      <div className="prose max-w-none rounded-2xl border border-border-subtle bg-bg-card p-6">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.content || week.plan || ""}</ReactMarkdown>
      </div>
    );
  }
  if (days.length === 0) return <Empty text="本周没有训练安排" />;
  const canPushAll = actions?.onPushAll != null && (actions.canPushRun || actions.canPushStrength);
  return (
    <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card shadow-sm" aria-label="本周训练课表">
      {canPushAll && (
        <div className="flex justify-end border-b border-border-subtle p-3">
          <PushButton onClick={() => actions?.onPushAll?.()} label="推送本周全部" />
        </div>
      )}
      {days.map((day) => (
        <article key={day.date} className="grid gap-4 border-b border-border-subtle p-4 last:border-b-0 sm:grid-cols-[78px_minmax(0,1fr)] sm:p-5">
          <div className="border-border-subtle sm:border-r">
            <p className="text-xs font-bold uppercase text-text-muted">{weekdayCN(day.date)}</p>
            <p className="mt-1 font-mono text-lg font-bold text-text-primary">{formatDateShort(day.date).replace("月", "/").replace("日", "")}</p>
          </div>
          <div className="space-y-3">
            {day.sessions.length === 0 ? (
              <div className="rounded-xl bg-bg-secondary px-4 py-3 text-sm text-text-muted">无训练安排</div>
            ) : (
              day.sessions.map((session) => <SessionRow key={session.session_index} session={session} actions={actions} />)
            )}
            {day.nutrition && <NutritionLine nutrition={day.nutrition} />}
          </div>
        </article>
      ))}
    </section>
  );
}

function SessionRow({ session, actions }: { session: PlannedSession; actions?: WeeklyPlanActions }) {
  const target = sessionTarget(session);
  const quality = session.kind === "run" && /interval|tempo|threshold|vo2|max|间歇|节奏|阈值/i.test(session.summary + " " + (session.notes_md ?? ""));
  const canPush =
    actions?.onPushSession != null && ((session.kind === "run" && actions.canPushRun) || (session.kind === "strength" && actions.canPushStrength));
  return (
    <div className="rounded-xl border border-border-subtle p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={"rounded px-2.5 py-1 text-xs font-bold " + kindStyle[session.kind]}>{kindLabel[session.kind]}</span>
        {quality && <span className="rounded bg-red-soft px-2.5 py-1 text-xs font-bold text-accent-red">Quality</span>}
        <h2 className="text-base font-bold text-text-primary">{session.summary}</h2>
        {canPush && <PushButton onClick={() => actions?.onPushSession?.(session.session_index)} label="推送" />}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-sm text-text-muted">
        <span>{formatSessionLoad(session)}</span>
        {target && <span>{target}</span>}
        {formatEstimatedDose(session) && <span className="font-semibold text-accent-green">{formatEstimatedDose(session)}</span>}
      </div>
      <p className="mt-2 whitespace-pre-line text-sm leading-6 text-text-secondary">
        {session.notes_md || session.spec?.note || "按计划执行，并根据当日恢复状态保持动作与配速质量。"}
      </p>
    </div>
  );
}

function NutritionLine({ nutrition }: { nutrition: NonNullable<PlanDay["nutrition"]> }) {
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

function StrengthTab({ days }: { days: PlanDay[] }) {
  const sessions = days.flatMap((day) => day.sessions).filter((session) => session.kind === "strength");
  const totalExercises = sessions.reduce((total, session) => total + (session.spec?.schema === "strength-workout/v1" ? session.spec.exercises.length : 0), 0);
  if (sessions.length === 0) return <Empty text="本周没有独立力量训练安排" />;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-text-muted">本周力量训练 · from structured sessions</p>
              <h2 className="mt-2 text-2xl font-bold text-text-primary">{sessions.length} 次力量维护，服务本周跑步计划</h2>
              <p className="mt-2 text-sm text-text-muted">动作、组数和执行重点来自结构化力量计划。</p>
            </div>
            <span className="rounded-full bg-purple-soft px-3 py-1 font-mono text-xs font-bold text-accent-purple">{totalExercises} 个动作</span>
          </div>
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            {sessions.map((session) => (
              <StrengthCard key={session.date + "-" + session.session_index} session={session} />
            ))}
          </div>
        </section>
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-text-primary">与跑步课的关系</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {sessions.map((session) => {
              const run = days.find((day) => day.date === session.date)?.sessions.find((item) => item.kind === "run");
              return (
                <div key={session.date + "-" + session.session_index + "-relationship"} className="rounded-xl bg-bg-secondary p-4">
                  <p className="text-xs font-bold text-accent-purple">{weekdayCN(session.date)}</p>
                  <p className="mt-2 text-sm font-semibold text-text-primary">{run ? "承接「" + run.summary + "」" : "独立力量维护"}</p>
                  <p className="mt-2 text-xs leading-5 text-text-muted">动作质量优先，不额外制造跑步强度；如当日腿部疲劳明显，可减少一组。</p>
                </div>
              );
            })}
            <div className="rounded-xl bg-bg-secondary p-4">
              <p className="text-xs font-bold text-accent-purple">执行原则</p>
              <p className="mt-2 text-sm font-semibold text-text-primary">不追求力竭或爆发</p>
              <p className="mt-2 text-xs leading-5 text-text-muted">力量训练服务跑姿、稳定性和伤病预防，避免影响下一节关键跑步课。</p>
            </div>
          </div>
        </section>
      </div>
      <aside className="space-y-4">
        <InfoCard title="执行规则" text="动作名和组数来自本周结构化计划；动作质量优先于次数和负重。" />
        <InfoCard title="疲劳调整" text="关键跑步课后若小腿、跟腱或髋部反应明显，只保留核心和灵活性动作。" amber />
      </aside>
    </div>
  );
}

function StrengthCard({ session }: { session: PlannedSession }) {
  const exercises = session.spec?.schema === "strength-workout/v1" ? session.spec.exercises : [];
  return (
    <article className="rounded-xl border border-border-subtle p-5">
      <p className="font-mono text-xs text-accent-purple">
        {weekdayCN(session.date)} · {formatDateShort(session.date)}
      </p>
      <h3 className="mt-2 text-lg font-bold text-text-primary">{session.summary}</h3>
      <div className="mt-4 space-y-3">
        {exercises.length === 0 ? (
          <p className="text-sm text-text-muted">该力量课暂无动作明细。</p>
        ) : (
          exercises.map((exercise) => (
            <div key={exercise.canonical_id} className="rounded-xl bg-bg-secondary p-3">
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm font-semibold text-text-primary">{exercise.display_name}</p>
                <span className="whitespace-nowrap font-mono text-xs text-accent-purple">
                  {exercise.sets} × {exercise.target_value}
                  {exercise.target_kind === "time_s" ? "s" : ""}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-text-muted">{exercise.note || "保持控制与稳定"}</p>
            </div>
          ))
        )}
      </div>
      {session.notes_md && <p className="mt-4 rounded-lg bg-purple-soft p-3 text-xs leading-5 text-text-secondary">{session.notes_md}</p>}
    </article>
  );
}

function RecordsTab({ days, activities }: { days: PlanDay[]; activities: WeeklyActivity[] }) {
  const stats = weeklyStats(days);
  const actualKm = actualRunKm(activities);
  const percent = stats.plannedRunKm > 0 ? Math.min(100, Math.round((actualKm / stats.plannedRunKm) * 100)) : 0;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        <section className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-card shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border-subtle p-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-text-muted">实际训练</p>
              <h2 className="mt-2 text-2xl font-bold text-text-primary">本周训练记录</h2>
              <p className="mt-2 text-sm text-text-muted">展示本周已同步的全部活动，不要求与计划课逐项对应。</p>
            </div>
            <span className="rounded-full border border-border-subtle bg-bg-secondary px-3 py-1 text-xs font-bold text-text-secondary">
              {activities.length} 次记录
            </span>
          </div>
          <div className="divide-y divide-border-subtle">
            {activities.length === 0 ? (
              <p className="p-8 text-center text-sm text-text-muted">本周暂无已同步训练</p>
            ) : (
              activities.map((activity) => (
                <div key={activity.label_id} className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_120px_120px_86px] sm:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-text-primary">{activity.name || sportName(activity)}</p>
                    <p className="mt-1 font-mono text-[11px] text-text-muted">
                      {sportName(activity)}
                      {activity.train_type ? " · " + activity.train_type : ""}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-text-muted">训练数据</p>
                    <p className="mt-1 font-mono text-sm font-bold text-accent-green">
                      {activity.distance_km > 0 ? activity.distance_km.toFixed(1) + " km" : activity.duration_fmt}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-text-muted">日期</p>
                    <p className="mt-1 font-mono text-xs text-text-secondary">{formatDateShort(activity.date)}</p>
                  </div>
                  <span className="w-fit rounded-full bg-green-soft px-2 py-1 text-[10px] font-bold text-accent-green">已同步</span>
                </div>
              ))
            )}
          </div>
        </section>
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-text-primary">完成后重点复盘</h3>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <QualityCard label="关键课稳定性" />
            <QualityCard label="低强度承接质量" />
            <QualityCard label="营养执行" />
          </div>
        </section>
      </div>
      <aside className="space-y-4">
        <div className="rounded-xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-text-primary">本周汇总</h3>
          <div className="mt-5 flex justify-between text-xs">
            <span>跑量</span>
            <span className="font-mono">
              {actualKm.toFixed(1)} / {stats.plannedRunKm.toFixed(1)} km
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-secondary">
            <div className="h-full rounded-full bg-accent-green" style={{ width: percent + "%" }} />
          </div>
          <div className="mt-5 flex justify-between border-t border-border-subtle pt-4 text-xs">
            <span>已同步活动</span>
            <strong>{activities.length} 次</strong>
          </div>
        </div>
        <InfoCard title="Coach 复盘提示" text="优先查看关键课目标是否稳定、轻松跑是否守住低强度，以及营养日是否按计划执行。" amber />
      </aside>
    </div>
  );
}

function FeedbackTab({ days, feedback, updatedAt, actions }: { days: PlanDay[]; feedback: string; updatedAt: string | null; actions?: WeeklyPlanActions }) {
  const keySessions = weeklyStats(days)
    .sessions.filter((session) => session.kind === "run")
    .slice(0, 3);
  const [draft, setDraft] = useState(feedback);
  const canEdit = actions?.onSaveFeedback != null;
  const dirty = canEdit && draft !== feedback;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm sm:p-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-text-muted">本周反馈</p>
            <h2 className="mt-1 text-2xl font-bold text-text-primary">围绕本周关键课记录体感</h2>
            <p className="mt-2 text-sm text-text-muted">Admin 只读展示用户已提交的反馈。</p>
          </div>
          {canEdit ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={8}
                placeholder="记录本周训练感受、完成度与恢复状态…"
                className="mt-5 min-h-60 w-full resize-y rounded-xl border border-border-subtle bg-bg-secondary p-4 font-mono text-sm leading-6 text-text-primary outline-none focus:border-accent-green/40"
              />
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  disabled={!dirty}
                  onClick={() => actions?.onSaveFeedback?.(draft)}
                  className="rounded-xl bg-accent-green px-4 py-2 text-xs font-semibold text-white transition disabled:opacity-40"
                >
                  保存反馈
                </button>
              </div>
            </>
          ) : (
            <div className="mt-5 min-h-60 whitespace-pre-wrap rounded-xl border border-border bg-bg-secondary p-4 font-mono text-sm leading-6 text-text-primary">
              {feedback || "本周尚未提交反馈。"}
            </div>
          )}
          {updatedAt && <p className="mt-3 text-xs text-text-muted">最后更新：{new Date(updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</p>}
        </section>
        <section className="rounded-2xl border border-border-subtle bg-bg-card p-5 shadow-sm">
          <h3 className="text-sm font-bold text-text-primary">建议记录节点</h3>
          <div className="mt-4 space-y-3">
            {keySessions.length === 0 ? (
              <p className="text-sm text-text-muted">当前没有可展示的关键跑步课。</p>
            ) : (
              keySessions.map((session, index) => (
                <div key={session.date + "-" + session.session_index} className="rounded-xl border border-border-subtle p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <p className="text-sm font-bold text-text-primary">
                      {weekdayCN(session.date)} · {session.summary}
                    </p>
                    <span className="text-[10px] font-bold text-accent-amber">{index === 0 ? "关键反馈" : "恢复反馈"}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-text-secondary">
                    计划 {formatSessionLoad(session)}
                    {sessionTarget(session) ? " · " + sessionTarget(session) : ""}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
      <aside className="space-y-4">
        <InfoCard title="建议补充" text="RPE、疼痛位置与持续时间、睡眠与腿部疲劳、营养和补水执行。" />
        <InfoCard title="会触发调整的反馈" text="连续腿沉、疼痛、关键课无法完成或长距离恢复异常。" amber />
      </aside>
    </div>
  );
}
