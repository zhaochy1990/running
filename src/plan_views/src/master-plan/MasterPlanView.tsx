import type React from "react";
import { useMemo, useState } from "react";
import {
  buildHeroLede,
  buildMileageBars,
  buildPhaseSpans,
  currentWeekNumber,
  findPhaseForDate,
  formatActualDose,
  formatDistanceValue,
  formatDoseRange,
  formatHr,
  formatKm,
  formatPace,
  formatRange,
  formatShort,
  formatSlashDate,
  formatWeekDateRange,
  type MileageBar,
  mileageBarFillColor,
  numberOrNull,
  type PhaseSpan,
  type PhaseVisual,
  padWeek,
  phaseKind,
  phaseVisual,
  selectNextMilestone,
  shanghaiToday,
  shortPhaseName,
  type TargetSummary,
  targetFromPlan,
} from "../lib/masterPlanView";
import type { CompletedPhaseSummary, MasterPlanMilestone, MasterPlanPhase, MasterPlanWeek, SeasonPlanContent } from "../types";

type PlanTab = "overview" | "weeks";
type CycleMetric = "mileage" | "load";

export interface MasterPlanViewProps {
  plan: SeasonPlanContent;
  actions?: {
    /** Navigate to the plan adjust flow for this season plan. */
    onAdjust?: () => void;
  };
}

export function MasterPlanView({ plan, actions }: MasterPlanViewProps) {
  const [tab, setTab] = useState<PlanTab>("overview");
  const [selectedPhaseId, setSelectedPhaseId] = useState<string | null>(null);
  const target = targetFromPlan(plan);
  const today = shanghaiToday();
  const spans = useMemo(() => buildPhaseSpans(plan.phases ?? [], plan.total_weeks), [plan.phases, plan.total_weeks]);
  const totalWeeks = plan.total_weeks ?? spans.at(-1)?.weekEnd ?? 1;
  const currentWeek = plan.current_week_number ?? currentWeekNumber(plan.start_date, today, totalWeeks);
  const currentPhaseId = plan.current_phase_id ?? findPhaseForDate(plan.phases, today)?.id ?? plan.phases[0]?.id ?? null;
  const currentSpan = spans.find((span) => span.phase.id === currentPhaseId) ?? spans[0] ?? null;
  const heroTitle = target.raceName || "赛季训练计划";

  return (
    <div className="master-plan-surface mx-auto max-w-7xl animate-fade-in">
      <section className="mb-6 flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="mb-2 font-mono text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase">赛季训练计划 · 已启用</p>
          <h1 className="break-words text-[28px] font-semibold leading-[1.1] text-text-primary sm:text-[32px]">{heroTitle}</h1>
          <p className="mt-3 max-w-[920px] text-sm leading-6 text-text-secondary">
            {buildHeroLede(plan, target, currentSpan?.phase ?? null, totalWeeks, currentWeek)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          {actions?.onAdjust && (
            <button
              type="button"
              onClick={actions.onAdjust}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent-green px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-accent-green-dim"
            >
              调整计划
            </button>
          )}
          {!actions?.onAdjust && (
            <span className="inline-flex h-9 shrink-0 items-center rounded-lg border border-green-edge bg-green-soft px-4 font-mono text-[11px] font-semibold text-accent-green">
              只读预览
            </span>
          )}
        </div>
      </section>

      <div className="mb-6 flex flex-wrap gap-2">
        <PlanTabButton active={tab === "overview"} onClick={() => setTab("overview")}>
          赛季总览
        </PlanTabButton>
        <PlanTabButton active={tab === "weeks"} onClick={() => setTab("weeks")}>
          训练周列表
        </PlanTabButton>
      </div>

      {tab === "weeks" ? (
        <PlanWeeksGrid weeks={plan.weeks ?? []} phases={plan.phases ?? ([] as MasterPlanPhase[])} currentWeek={currentWeek} />
      ) : (
        <SeasonOverviewBody plan={plan} target={target} selectedPhaseId={selectedPhaseId} onSelectPhase={setSelectedPhaseId} />
      )}
    </div>
  );
}

function PlanTabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${
        active
          ? "border-border-subtle bg-bg-card text-text-primary shadow-sm"
          : "border-transparent bg-transparent text-text-muted hover:border-border-subtle hover:bg-bg-card hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function SeasonOverviewBody({
  plan,
  target,
  selectedPhaseId,
  onSelectPhase,
}: {
  plan: SeasonPlanContent;
  target: TargetSummary;
  selectedPhaseId: string | null;
  onSelectPhase: (id: string) => void;
}) {
  const today = shanghaiToday();
  const phases = useMemo(() => plan.phases ?? [], [plan.phases]);
  const milestones = plan.milestones ?? [];
  const spans = useMemo(() => buildPhaseSpans(phases, plan.total_weeks), [phases, plan.total_weeks]);
  const totalWeeks = plan.total_weeks ?? spans.at(-1)?.weekEnd ?? 1;
  const currentWeek = plan.current_week_number ?? currentWeekNumber(plan.start_date, today, totalWeeks);
  const currentPhaseId = plan.current_phase_id ?? findPhaseForDate(phases, today)?.id ?? phases[0]?.id ?? null;
  const activePhaseId = selectedPhaseId ?? currentPhaseId;
  const activeSpan = spans.find((span) => span.phase.id === activePhaseId) ?? spans[0] ?? null;
  const currentSpan = spans.find((span) => span.phase.id === currentPhaseId) ?? activeSpan;

  return (
    <div className="space-y-6">
      {spans.length > 0 && <MileageCycleCard plan={plan} spans={spans} totalWeeks={totalWeeks} currentWeek={currentWeek} onSelectPhase={onSelectPhase} />}
      {spans.length > 0 && (
        <PhasePills spans={spans} activePhaseId={activeSpan?.phase.id ?? null} currentPhaseId={currentPhaseId} onSelectPhase={onSelectPhase} />
      )}
      <SummaryCards
        plan={plan}
        target={target}
        currentWeek={currentWeek}
        currentPhase={currentSpan?.phase ?? null}
        nextMilestone={selectNextMilestone(plan, today)}
      />
      {activeSpan && (
        <PhaseDetail
          phase={activeSpan.phase}
          index={activeSpan.index}
          span={activeSpan}
          milestones={milestones.filter((milestone) => milestone.phase_id === activeSpan.phase.id)}
        />
      )}
      {(plan.training_principles ?? []).length > 0 && <TrainingPrinciples principles={plan.training_principles} />}
    </div>
  );
}

function MileageCycleCard({
  plan,
  spans,
  totalWeeks,
  currentWeek,
  onSelectPhase,
}: {
  plan: SeasonPlanContent;
  spans: PhaseSpan[];
  totalWeeks: number;
  currentWeek: number;
  onSelectPhase: (id: string) => void;
}) {
  const [metric, setMetric] = useState<CycleMetric>("mileage");
  const bars = useMemo(() => buildMileageBars(plan, spans, totalWeeks, currentWeek), [plan, spans, totalWeeks, currentWeek]);
  const columns = Math.max(bars.length, 1);
  const loadAvailable = plan.training_load_projection?.status === "available" && bars.some((bar) => bar.plannedDoseLow != null && bar.plannedDoseHigh != null);
  const activeMetric: CycleMetric = metric === "load" && loadAvailable ? "load" : "mileage";
  const maxDose = Math.max(...bars.flatMap((bar) => [bar.plannedDoseHigh ?? 0, bar.actualDose ?? 0]), 1);

  return (
    <section className="overflow-visible rounded-lg border border-border-subtle bg-bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-lg border-b border-border-subtle px-5 py-4">
        <h2 className="text-lg font-semibold text-text-primary">训练周期</h2>
        <div className="inline-flex rounded-lg border border-border-subtle bg-bg-secondary p-0.5">
          <CycleMetricButton active={activeMetric === "mileage"} onClick={() => setMetric("mileage")}>
            跑量
          </CycleMetricButton>
          <CycleMetricButton active={activeMetric === "load"} disabled={!loadAvailable} onClick={() => setMetric("load")}>
            负荷
          </CycleMetricButton>
        </div>
      </div>
      <div className="px-5 py-5 sm:px-6">
        <p className="mb-4 font-mono text-[10px] font-semibold tracking-[0.14em] text-text-muted uppercase">
          {activeMetric === "load" ? "周负荷（STRIDE DOSE）" : "周跑量（KM/周）"}
        </p>
        <div className="grid h-40 items-end gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {bars.map((bar) => {
            const visual = phaseVisual(bar.phase, bar.phaseIndex);
            const hasLoadRange = bar.plannedDoseLow != null && bar.plannedDoseHigh != null;
            const loadScale = Math.max(bar.plannedDoseHigh ?? 0, bar.actualDose ?? 0);
            const loadHeight = loadScale > 0 ? Math.max(8, Math.round((loadScale / maxDose) * 100)) : 0;
            const lowPct = loadScale > 0 && bar.plannedDoseLow != null ? Math.min(100, (bar.plannedDoseLow / loadScale) * 100) : 0;
            const highPct = loadScale > 0 && bar.plannedDoseHigh != null ? Math.min(100, (bar.plannedDoseHigh / loadScale) * 100) : 0;
            const actualPct = loadScale > 0 && bar.actualDose != null ? Math.min(100, (bar.actualDose / loadScale) * 100) : 0;
            return (
              <button
                key={bar.week}
                type="button"
                title={bar.title}
                aria-label={bar.title}
                onClick={() => onSelectPhase(bar.phase.id)}
                className={`group relative rounded-t border border-transparent transition-all hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-green focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary ${activeMetric === "load" && !hasLoadRange && bar.actualDose == null ? "min-h-0" : "min-h-[10px]"} ${bar.isCurrent ? "ring-2 ring-accent-green ring-offset-2 ring-offset-bg-primary" : ""}`}
                style={{
                  height: `${activeMetric === "load" ? loadHeight : bar.heightPct}%`,
                  backgroundColor: activeMetric === "load" ? "transparent" : `color-mix(in oklab, ${visual.color} 12%, var(--surface))`,
                  borderColor: bar.isCompleted ? `color-mix(in oklab, ${visual.color} 38%, transparent)` : "transparent",
                }}
              >
                {activeMetric === "load" ? (
                  <>
                    {hasLoadRange && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 rounded-sm border"
                        style={{
                          bottom: `${lowPct}%`,
                          height: `${Math.max(2, highPct - lowPct)}%`,
                          borderColor: `color-mix(in oklab, ${visual.color} 48%, transparent)`,
                          backgroundColor: `color-mix(in oklab, ${visual.color} 16%, var(--surface))`,
                        }}
                      />
                    )}
                    {bar.actualDose != null && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-[22%] bottom-0 rounded-t-sm"
                        style={{ height: `${actualPct}%`, backgroundColor: visual.color }}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 bottom-0 rounded-t"
                      style={{ height: `${bar.fillPct}%`, backgroundColor: mileageBarFillColor(bar, visual) }}
                    />
                    {bar.plannedLinePct != null && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute right-0 left-0 border-t-2 border-dashed border-text-primary/80"
                        style={{ bottom: `${bar.plannedLinePct}%` }}
                      />
                    )}
                  </>
                )}
                {bar.isCurrent && (
                  <span className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] font-semibold text-accent-green">
                    W{padWeek(bar.week)} 当前
                  </span>
                )}
                <MileageTooltip bar={bar} />
              </button>
            );
          })}
        </div>
        {activeMetric === "load" ? (
          <div className="mt-3 space-y-2 font-mono text-[10px] text-text-muted">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-1.5 rounded-sm bg-accent-green" />
                实际负荷
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-4 rounded-sm border border-accent-green/50 bg-accent-green/15" />
                计划负荷区间
              </span>
            </div>
            <p>STRIDE dose 对比每周计划负荷区间与实际完成负荷。</p>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[10px] text-text-muted">
            <span className="inline-flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-sm bg-accent-green" />
              已完成周实际跑量
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="h-0 w-4 border-t-2 border-dashed border-text-primary/70" />
              计划跑量标记
            </span>
          </div>
        )}
        {!loadAvailable && (
          <p className="mt-3 rounded border border-border-subtle bg-bg-secondary px-3 py-2 text-xs text-text-muted">该计划尚无可用的周负荷数据</p>
        )}
        <div className="mt-3 grid font-mono text-[10px] text-text-muted" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {spans.map((span) => (
            <div
              key={span.phase.id}
              className="min-w-0 text-left"
              style={{ gridColumn: `${span.weekStart} / span ${Math.max(1, Math.min(span.weekCount, 3))}` }}
            >
              <span>{formatShort(span.phase.start_date)}</span>
              <br />
              <span className="font-sans text-[11px] text-text-secondary">{shortPhaseName(span.phase, span.index)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CycleMetricButton({
  active,
  disabled = false,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 font-mono text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? "border border-green-edge bg-green-soft text-accent-green" : "border border-transparent text-text-muted hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function MileageTooltip({ bar }: { bar: MileageBar }) {
  return (
    <span className="pointer-events-none absolute bottom-[calc(100%+12px)] left-1/2 z-20 hidden w-52 -translate-x-1/2 rounded-md border border-border-subtle bg-bg-card p-3 text-left shadow-lg group-hover:block group-focus-visible:block">
      <span className="mb-2 block font-mono text-[10px] font-semibold text-text-primary">
        W{padWeek(bar.week)}
        {bar.weekStart ? ` · ${formatWeekDateRange(bar.weekStart, bar.weekEnd)}` : ""}
      </span>
      <span className="grid gap-1.5 font-mono text-[10px] leading-4 text-text-secondary">
        <TooltipRow label="计划跑量" value={formatRange(bar.plannedKmLow, bar.plannedKm, "km")} />
        <TooltipRow label="计划负荷" value={formatDoseRange(bar.plannedDoseLow, bar.plannedDoseHigh)} />
        <TooltipRow label="实际负荷" value={formatActualDose(bar)} />
        <TooltipRow label="实际跑量" value={bar.source === "actual" ? formatKm(bar.actualKm) : bar.isCompleted ? "无跑步记录" : "未完成"} />
        <TooltipRow label="跑步次数" value={bar.actualRunCount > 0 ? `${bar.actualRunCount} 次` : "--"} />
        <TooltipRow label="实际均配" value={bar.source === "actual" ? formatPace(bar) : "--"} />
        <TooltipRow label="实际均心率" value={bar.source === "actual" ? formatHr(bar) : "--"} />
      </span>
    </span>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex justify-between gap-3">
      <span>{label}</span>
      <span className="text-text-primary">{value}</span>
    </span>
  );
}

function PhasePills({
  spans,
  activePhaseId,
  currentPhaseId,
  onSelectPhase,
}: {
  spans: PhaseSpan[];
  activePhaseId: string | null;
  currentPhaseId: string | null;
  onSelectPhase: (id: string) => void;
}) {
  return (
    <section className="flex flex-wrap gap-2">
      {spans.map((span) => {
        const active = span.phase.id === activePhaseId;
        const visual = phaseVisual(span.phase, span.index);
        const suffix = span.phase.is_completed ? "（已完成）" : span.phase.id === currentPhaseId ? "（当前）" : "";
        return (
          <button
            key={span.phase.id}
            type="button"
            onClick={() => onSelectPhase(span.phase.id)}
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] font-semibold leading-none transition-colors hover:bg-bg-card-hover"
            style={{
              borderColor: active ? visual.edge : "var(--border-subtle)",
              backgroundColor: active ? visual.soft : "var(--surface)",
              color: active ? visual.color : "var(--muted)",
            }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: visual.color }} />
            {span.phase.name}
            {suffix} · {span.weekCount}周
          </button>
        );
      })}
    </section>
  );
}

function SummaryCards({
  plan,
  target,
  currentWeek,
  currentPhase,
  nextMilestone,
}: {
  plan: SeasonPlanContent;
  target: TargetSummary;
  currentWeek: number;
  currentPhase: MasterPlanPhase | null;
  nextMilestone: MasterPlanMilestone | null;
}) {
  const targetMeta = [target.raceDate && formatSlashDate(target.raceDate), target.distance].filter(Boolean).join(" · ");
  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
      <MetricCard label="当前周" value={`W${padWeek(currentWeek)}`} detail={currentPhase?.name ?? "暂无当前阶段"} />
      <MetricCard label="目标赛事" value={target.raceName || "尚未设置"} detail={targetMeta || `${formatSlashDate(plan.end_date)} 前完成赛季计划`} />
      <MetricCard label="目标成绩" value={target.targetTime || "完赛"} detail="Asia/Shanghai" />
      <MetricCard
        label="下一里程碑"
        value={nextMilestone ? formatSlashDate(nextMilestone.date) : "暂无"}
        detail={nextMilestone?.target ?? "当前阶段暂无关键里程碑"}
      />
    </section>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-card p-4">
      <p className="mb-1 font-mono text-[10px] font-semibold tracking-[0.12em] text-text-muted uppercase">{label}</p>
      <p className="truncate text-xl leading-tight font-bold text-text-primary md:text-[22px]">{value}</p>
      <p className="mt-2 line-clamp-3 text-sm leading-5 text-text-secondary">{detail}</p>
    </div>
  );
}

function PhaseDetail({ phase, index, span, milestones }: { phase: MasterPlanPhase; index: number; span: PhaseSpan; milestones: MasterPlanMilestone[] }) {
  const visual = phaseVisual(phase, index);
  const triggers = phase.monitoring_triggers ?? [];
  const keySessionTypes = phase.key_session_types ?? [];
  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <div
        className="flex flex-col gap-3 border-b border-border-subtle px-5 py-4 sm:flex-row sm:items-center"
        style={{ backgroundColor: `color-mix(in oklab, ${visual.soft} 54%, var(--surface))` }}
      >
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: visual.color }} />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-text-primary">{phase.name}</h2>
          <p className="mt-1 font-mono text-[10px] text-text-muted">
            {formatSlashDate(phase.start_date)} - {formatSlashDate(phase.end_date)} · {phase.phase_type ?? phaseKind(phase, index)}
            {phase.is_completed ? " · 已完成" : ""}
          </p>
        </div>
        <span className="font-mono text-xs font-semibold text-text-secondary">{formatDistanceValue(phase)} km/w</span>
      </div>
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article className="min-w-0 space-y-5">
          <PhaseTextBlock title="阶段重点" body={phase.focus || "暂无阶段重点"} />
          {phase.rhythm && <PhaseTextBlock title="阶段节奏" body={phase.rhythm} />}
          {phase.key_workouts && <PhaseTextBlock title="关键课" body={phase.key_workouts} />}
          <div>
            <h3 className="mb-2 text-[16px] font-bold text-text-primary">监控触发</h3>
            {triggers.length > 0 ? (
              <ul className="space-y-2 text-sm leading-6 text-text-primary">
                {triggers.map((trigger) => (
                  <li key={trigger} className="flex gap-2">
                    <RadioCheckIcon color={visual.color} />
                    <span>{trigger}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">暂无监控触发</p>
            )}
          </div>
          {phase.coach_note && (
            <blockquote
              className="rounded border p-4 font-editorial text-base leading-7 text-text-primary italic"
              style={{ borderColor: visual.edge, backgroundColor: visual.soft }}
            >
              <h3 className="mb-2 font-sans text-[16px] font-bold not-italic" style={{ color: visual.color }}>
                Coach Note
              </h3>
              {phase.coach_note}
            </blockquote>
          )}
          {phase.is_completed && phase.summary && <CompletedPhaseResults summary={phase.summary} visual={visual} />}
        </article>
        <aside className="space-y-4">
          <SideBlock title="关键课型">
            {keySessionTypes.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {keySessionTypes.map((session) => (
                  <span key={session} className="rounded border border-border-subtle bg-bg-elevated px-2 py-1 font-mono text-[10px] text-text-secondary">
                    {session}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">无关键课型</p>
            )}
          </SideBlock>
          <SideBlock title="周里程区间">
            <p className="text-[28px] font-bold text-text-primary">
              {formatDistanceValue(phase)}
              <span className="text-sm font-normal text-text-secondary"> km/w</span>
            </p>
            <p className="mt-1 text-sm text-text-muted">
              W{padWeek(span.weekStart)}-W{padWeek(span.weekEnd)} · {formatShort(phase.start_date)} - {formatShort(phase.end_date)}
            </p>
          </SideBlock>
          <SideBlock title="关键里程碑">
            {milestones.length > 0 ? (
              <div className="space-y-3">
                {milestones.map((milestone) => (
                  <div key={milestone.id} className="rounded border border-border-subtle bg-bg-elevated p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="font-mono text-xs font-semibold" style={{ color: visual.color }}>
                        {formatSlashDate(milestone.date)}
                      </span>
                      <span className="font-mono text-[10px] text-text-muted">{milestone.type}</span>
                    </div>
                    <p className="text-sm leading-6 text-text-primary">{milestone.completed_actual || milestone.target}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted">暂无关键里程碑</p>
            )}
          </SideBlock>
        </aside>
      </div>
    </section>
  );
}

function PhaseTextBlock({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="mb-2 text-[16px] font-bold text-text-primary">{title}</h3>
      <p className="text-[15px] leading-7 text-text-primary">{body}</p>
    </div>
  );
}

function SideBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-border-subtle bg-bg-secondary p-4">
      <p className="mb-3 font-mono text-[10px] font-semibold tracking-[0.12em] text-text-muted uppercase">{title}</p>
      {children}
    </div>
  );
}

function CompletedPhaseResults({ summary, visual }: { summary: CompletedPhaseSummary; visual: PhaseVisual }) {
  const stats = [
    { label: "总跑量", value: `${summary.total_distance_km} km` },
    { label: "跑步次数", value: String(summary.run_count) },
    { label: "均配", value: summary.avg_pace_fmt ? `${summary.avg_pace_fmt}/km` : "暂无" },
    { label: "均心率", value: summary.avg_hr != null ? `${summary.avg_hr} bpm` : "暂无" },
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded border border-border-subtle bg-bg-secondary p-3">
            <p className="mb-1 font-mono text-[10px] text-text-muted">{stat.label}</p>
            <p className="font-bold text-text-primary">{stat.value}</p>
          </div>
        ))}
      </div>
      {(summary.hr_zone_distribution ?? []).length > 0 && (
        <div className="rounded border border-border-subtle bg-bg-secondary p-3">
          <p className="mb-2 font-mono text-[10px] text-text-muted">心率区间分布</p>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {summary.hr_zone_distribution.map((zone) => (
              <div key={zone.zone_index} className="flex justify-between gap-3 text-xs text-text-secondary">
                <span style={{ color: visual.color }}>Z{zone.zone_index}</span>
                <span>
                  {zone.percent}% · {zone.minutes}min
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TrainingPrinciples({ principles }: { principles: string[] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-subtle bg-bg-card">
      <div className="border-b border-border-subtle px-5 py-4">
        <h2 className="text-lg font-semibold text-text-primary">训练原则</h2>
      </div>
      <ol className="space-y-3 p-5 sm:p-6">
        {principles.map((principle, index) => (
          <li key={principle} className="flex gap-3">
            <span className="mt-1 font-mono text-xs font-semibold text-accent-green">{padWeek(index + 1)}</span>
            <span className="text-[15px] leading-7 text-text-primary">{principle}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function PlanWeeksGrid({ weeks, phases, currentWeek }: { weeks: MasterPlanWeek[]; phases: MasterPlanPhase[]; currentWeek: number }) {
  const phaseNames = new Map(phases.map((phase) => [phase.id, phase.name]));
  if (weeks.length === 0)
    return <div className="rounded-lg border border-border-subtle bg-bg-card py-10 text-center text-sm text-text-muted">该计划尚无训练周记录。</div>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {[...weeks]
        .sort((a, b) => a.week_index - b.week_index)
        .map((week) => {
          const isCurrent = week.week_index === currentWeek;
          const sessions = week.key_sessions ?? [];
          const actualKm = numberOrNull(week.actual_distance_km);
          const actualRunCount = week.actual_run_count ?? 0;
          const labels = [week.is_recovery_week && "调整周", week.is_taper_week && "减量周", week.is_completed && "已完成"].filter(Boolean);
          return (
            <article
              key={week.week_index}
              className={`rounded-xl border p-3.5 transition-all ${
                isCurrent ? "border-accent-green bg-gradient-to-b from-accent-green/5 to-transparent" : "border-border-subtle bg-bg-card"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="font-mono text-[11px] font-semibold text-text-primary">
                  W{padWeek(week.week_index)} · {formatWeekDateRange(week.week_start, week.week_end ?? null)}
                </span>
                <div className="flex flex-wrap justify-end gap-1">
                  {isCurrent && <span className="rounded bg-accent-green/10 px-1.5 py-px font-mono text-[9px] text-accent-green">当前</span>}
                  {labels.map((label) => (
                    <span key={label as string} className="rounded bg-bg-elevated px-1.5 py-px font-mono text-[9px] text-text-muted">
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <p className="mt-2 min-h-[2.6em] text-[12px] leading-snug text-text-secondary">
                {phaseNames.get(week.phase_id) || "训练周"}
                {sessions.length > 0 ? ` · ${sessions.map((session) => session.type).join("、")}` : ""}
              </p>
              <div className="mt-2.5 space-y-1.5 border-t border-border-subtle pt-2.5 font-mono text-[11px]">
                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">目标</span>
                  <span className="text-text-primary">
                    {formatRange(numberOrNull(week.target_weekly_km_low), numberOrNull(week.target_weekly_km_high), "km")} · {sessions.length} 个关键课
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-text-muted">实际</span>
                  <span className="text-text-primary">
                    {actualRunCount > 0 && actualKm != null ? formatKm(actualKm) : "--"} · {actualRunCount} 次
                  </span>
                </div>
              </div>
            </article>
          );
        })}
    </div>
  );
}

function RadioCheckIcon({ color }: { color: string }) {
  return (
    <svg className="mt-1 h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.4} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" fill={color} stroke="none" />
    </svg>
  );
}
