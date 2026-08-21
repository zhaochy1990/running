import type { MasterPlanMilestone, MasterPlanPhase, SeasonPlanContent } from "../types";

export interface TargetSummary {
  raceName: string;
  distance: string;
  raceDate: string;
  targetTime: string;
}

export interface PhaseSpan {
  phase: MasterPlanPhase;
  index: number;
  weekStart: number;
  weekEnd: number;
  weekCount: number;
}

export interface MileageBar {
  week: number;
  plannedKmLow: number | null;
  plannedKm: number | null;
  plannedDoseLow: number | null;
  plannedDoseHigh: number | null;
  actualDose: number | null;
  actualDoseCoverage: number | null;
  actualDoseStatus: "complete" | "partial" | "unknown" | null;
  actualKm: number | null;
  displayKm: number | null;
  heightPct: number;
  fillPct: number;
  plannedLinePct: number | null;
  phase: MasterPlanPhase;
  phaseIndex: number;
  weekStart: string | null;
  weekEnd: string | null;
  isCompleted: boolean;
  actualAvgPaceSec: number | null;
  actualAvgPaceFmt: string;
  actualAvgHr: number | null;
  actualRunCount: number;
  source: "actual" | "planned" | "estimated";
  isCurrent: boolean;
  isRecoveryWeek: boolean;
  isTaperWeek: boolean;
  title: string;
}

export interface PhaseVisual {
  color: string;
  soft: string;
  edge: string;
  label: string;
}

const PHASE_VISUALS: Record<string, PhaseVisual> = {
  base: { color: "var(--green)", soft: "var(--green-soft)", edge: "var(--green-edge)", label: "基础" },
  speed: { color: "var(--cyan)", soft: "var(--cyan-soft)", edge: "var(--cyan-edge)", label: "速度" },
  build: { color: "var(--teal-deep)", soft: "var(--cyan-soft)", edge: "var(--cyan-edge)", label: "专项" },
  peak: { color: "var(--amber)", soft: "var(--amber-soft)", edge: "var(--amber-edge)", label: "峰值" },
  taper: { color: "var(--purple)", soft: "var(--purple-soft)", edge: "var(--purple-edge)", label: "减量" },
  race: { color: "var(--red)", soft: "var(--red-soft)", edge: "var(--red-edge)", label: "比赛" },
  recovery: { color: "var(--faint)", soft: "var(--elevated)", edge: "var(--border-subtle)", label: "恢复" },
};
const PHASE_ORDER = ["base", "speed", "build", "peak", "taper", "race", "recovery"];

export function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function phaseKind(phase: MasterPlanPhase, index: number): string {
  if (phase.phase_type && PHASE_VISUALS[phase.phase_type]) return phase.phase_type;
  if (/基础|Base/i.test(phase.name)) return "base";
  if (/速度|Speed/i.test(phase.name)) return "speed";
  if (/峰值|Peak/i.test(phase.name)) return "peak";
  if (/专项|Build/i.test(phase.name)) return "build";
  if (/减量|Taper/i.test(phase.name)) return "taper";
  if (/比赛|Race/i.test(phase.name)) return "race";
  if (/恢复|Recovery/i.test(phase.name)) return "recovery";
  return PHASE_ORDER[index % PHASE_ORDER.length];
}

export function phaseVisual(phase: MasterPlanPhase, index: number): PhaseVisual {
  return PHASE_VISUALS[phaseKind(phase, index)] ?? PHASE_VISUALS.base;
}

export function shortPhaseName(phase: MasterPlanPhase, index: number): string {
  return `P${index + 1} ${phaseVisual(phase, index).label}`;
}

export function parseDateOnly(value: string): Date | null {
  const [year, month, day] = value.split("T")[0].split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : null;
}

export function weeksBetween(start: string, end: string): number {
  const first = parseDateOnly(start);
  const last = parseDateOnly(end);
  if (!first || !last || last < first) return 1;
  return Math.max(1, Math.ceil((Math.floor((last.getTime() - first.getTime()) / 86400000) + 1) / 7));
}

export function formatShort(value: string): string {
  const [, month, day] = value.split("T")[0].split("-");
  return month && day ? `${Number(month)}/${Number(day)}` : value;
}

export function formatSlashDate(value: string): string {
  const [year, month, day] = value.split("T")[0].split("-");
  return year && month && day ? `${year}/${month}/${day}` : value;
}

export function targetFromPlan(plan: SeasonPlanContent): TargetSummary {
  const distanceLabels: Record<string, string> = { HM: "半马", FM: "全马", trail: "越野" };
  return {
    raceName: plan.goal.race_name?.trim() || "",
    distance: distanceLabels[plan.goal.distance || ""] || plan.goal.distance || "",
    raceDate: plan.goal.race_date || "",
    targetTime: plan.goal.target_time || "",
  };
}

export function buildPhaseSpans(phases: MasterPlanPhase[], totalWeeks: number | null): PhaseSpan[] {
  let cursor = 1;
  const spans = phases.map((phase, index) => {
    const weekCount = weeksBetween(phase.start_date, phase.end_date);
    const span = { phase, index, weekStart: cursor, weekEnd: cursor + weekCount - 1, weekCount };
    cursor = span.weekEnd + 1;
    return span;
  });
  if (totalWeeks && spans.length > 0 && spans.at(-1)?.weekEnd !== totalWeeks) {
    const last = spans[spans.length - 1];
    last.weekEnd = totalWeeks;
    last.weekCount = Math.max(1, last.weekEnd - last.weekStart + 1);
  }
  return spans;
}

export function buildMileageBars(plan: SeasonPlanContent, spans: PhaseSpan[], totalWeeks: number, currentWeek: number): MileageBar[] {
  if (!spans[0]) return [];
  const targets = new Map((plan.weeks ?? []).map((week) => [week.week_index, week]));
  const raw = spans
    .flatMap((span) => {
      return Array.from({ length: span.weekCount }, (_, localIndex) => {
        const week = span.weekStart + localIndex;
        const target = targets.get(week);
        const effectiveSpan = spans.find((item) => item.phase.id === target?.phase_id) ?? span;
        const phase = effectiveSpan.phase;
        const plannedExplicit = target ? numberOrNull(target.planned_distance_km ?? target.target_weekly_km_high ?? target.target_weekly_km_low) : null;
        const plannedKm = plannedExplicit ?? interpolateWeeklyKm(phase, Math.max(0, week - effectiveSpan.weekStart), effectiveSpan.weekCount);
        const actualKm = numberOrNull(target?.actual_distance_km);
        const actualRunCount = target?.actual_run_count ?? 0;
        const hasActual = actualRunCount > 0 && actualKm != null;
        const isCompleted = target?.is_completed == null ? week < currentWeek : Boolean(target.is_completed);
        const displayKm = hasActual ? actualKm : (plannedKm ?? numberOrNull(phase.summary?.weekly_avg_km));
        return {
          week,
          plannedKmLow: target ? (numberOrNull(target.target_weekly_km_low ?? target.target_weekly_km_high) ?? plannedKm) : plannedKm,
          plannedKm,
          plannedDoseLow: numberOrNull(target?.target_training_dose_low),
          plannedDoseHigh: numberOrNull(target?.target_training_dose_high),
          actualDose: numberOrNull(target?.actual_training_dose),
          actualDoseCoverage: numberOrNull(target?.actual_training_dose_coverage),
          actualDoseStatus: parseDoseStatus(target?.actual_training_dose_status),
          actualKm: hasActual ? actualKm : null,
          displayKm,
          phase,
          phaseIndex: effectiveSpan.index,
          weekStart: target?.week_start ?? null,
          weekEnd: target?.week_end ?? null,
          isCompleted,
          actualAvgPaceSec: hasActual ? numberOrNull(target?.actual_avg_pace_s_km) : null,
          actualAvgPaceFmt: hasActual ? (target?.actual_avg_pace_fmt ?? "") : "",
          actualAvgHr: hasActual ? numberOrNull(target?.actual_avg_hr) : null,
          actualRunCount,
          source: hasActual ? ("actual" as const) : plannedExplicit != null ? ("planned" as const) : ("estimated" as const),
          isRecoveryWeek: Boolean(target?.is_recovery_week),
          isTaperWeek: Boolean(target?.is_taper_week),
        } as Omit<MileageBar, "heightPct" | "fillPct" | "plannedLinePct" | "isCurrent" | "title">;
      });
    })
    .filter((bar) => !totalWeeks || bar.week <= totalWeeks);
  const maxKm = Math.max(...raw.flatMap((bar) => [bar.plannedKm ?? 0, bar.displayKm ?? 0]), 1);
  return raw.map((bar) => {
    const scale = Math.max(bar.plannedKm ?? 0, bar.displayKm ?? 0);
    const fill = bar.displayKm == null ? 100 : Math.round((bar.displayKm / Math.max(scale, 1)) * 100);
    return {
      ...bar,
      heightPct: Math.max(8, Math.round((scale / maxKm) * 100)),
      fillPct: Math.max(bar.isCompleted ? 0 : 8, Math.min(100, fill)),
      plannedLinePct: bar.isCompleted && bar.plannedKm != null ? Math.round((bar.plannedKm / Math.max(scale, 1)) * 100) : null,
      isCurrent: bar.week === currentWeek,
      title: mileageBarTitle(bar),
    };
  });
}

export function currentWeekNumber(startDate: string, today: string, totalWeeks: number): number {
  const start = parseDateOnly(startDate);
  const current = parseDateOnly(today);
  if (!start || !current) return 1;
  const raw = Math.floor((current.getTime() - start.getTime()) / 604800000) + 1;
  return Math.max(1, Math.min(totalWeeks || raw, raw));
}

export function findPhaseForDate(phases: MasterPlanPhase[], today: string): MasterPlanPhase | null {
  const current = parseDateOnly(today);
  return current
    ? (phases.find((phase) => {
        const start = parseDateOnly(phase.start_date);
        const end = parseDateOnly(phase.end_date);
        return start && end && start <= current && end >= current;
      }) ?? null)
    : null;
}

export function selectNextMilestone(plan: SeasonPlanContent, today: string): MasterPlanMilestone | null {
  if (plan.next_milestone) return { ...plan.next_milestone, type: "next", phase_id: "", completed_actual: null };
  const sorted = [...(plan.milestones ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.find((milestone) => milestone.date >= today) ?? sorted.at(-1) ?? null;
}

export function buildHeroLede(
  plan: SeasonPlanContent,
  target: TargetSummary,
  currentPhase: MasterPlanPhase | null,
  totalWeeks: number,
  currentWeek: number,
): string {
  const parts = [
    `从 ${formatSlashDate(plan.start_date)} 到 ${formatSlashDate(plan.end_date)}，共 ${totalWeeks} 周。`,
    `当前处于第 ${currentWeek} 周${currentPhase ? ` · ${currentPhase.name}` : ""}，`,
    currentPhase?.focus ? `重点是 ${currentPhase.focus}。` : "重点随训练阶段推进动态更新。",
  ];
  if (target.raceDate && target.distance) parts.push(`目标赛事：${target.distance} · ${formatSlashDate(target.raceDate)}。`);
  return parts.join("");
}

export function interpolateWeeklyKm(phase: MasterPlanPhase, index: number, count: number): number | null {
  const low = phase.weekly_distance_km_low;
  const high = phase.weekly_distance_km_high;
  if (low == null && high == null) return null;
  if (low == null || high == null || count <= 1) return Math.round(high ?? low ?? 0);
  return Math.round(low + ((high - low) * index) / (count - 1));
}

export function numberOrNull(value: unknown): number | null {
  const number = value == null || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseDoseStatus(value: unknown): MileageBar["actualDoseStatus"] {
  return value === "complete" || value === "partial" || value === "unknown" ? value : null;
}

export function padWeek(week: number): string {
  return String(week).padStart(2, "0");
}

export function formatDistanceValue(phase: MasterPlanPhase): string {
  const low = phase.weekly_distance_km_low;
  const high = phase.weekly_distance_km_high;
  return low == null && high == null ? "--" : low == null || high == null ? String(low ?? high) : `${low}-${high}`;
}

export function formatKm(value: number | null): string {
  return value == null ? "--" : `${value.toFixed(value % 1 === 0 ? 0 : 1)} km`;
}

export function formatRange(low: number | null, high: number | null, suffix: string): string {
  if (low == null || high == null) return "--";
  const format = (value: number) => value.toFixed(value % 1 === 0 ? 0 : 1);
  return low === high ? `${format(low)} ${suffix}` : `${format(low)}-${format(high)} ${suffix}`;
}

export function formatDoseRange(low: number | null, high: number | null): string {
  return low == null || high == null ? "--" : Math.round(low) === Math.round(high) ? `${Math.round(low)} dose` : `${Math.round(low)}-${Math.round(high)} dose`;
}

export function formatActualDose(bar: MileageBar): string {
  if (bar.actualDose == null) return "--";
  const value = `${Math.round(bar.actualDose)} dose`;
  if (bar.actualDoseStatus !== "partial") return value;
  return bar.isCompleted ? `${value}（数据不完整）` : `${value}（截至目前）`;
}

export function formatPace(bar: MileageBar): string {
  if (bar.actualAvgPaceFmt) return `${bar.actualAvgPaceFmt}/km`;
  if (bar.actualAvgPaceSec == null) return "--";
  const seconds = Math.round(bar.actualAvgPaceSec);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}/km`;
}

export function formatHr(bar: MileageBar): string {
  return bar.actualAvgHr == null ? "--" : `${Math.round(bar.actualAvgHr)} bpm`;
}

export function mileageBarTitle(bar: Omit<MileageBar, "heightPct" | "fillPct" | "plannedLinePct" | "isCurrent" | "title">): string {
  const source = bar.source === "actual" ? "实际" : bar.source === "planned" ? "计划" : "估算";
  const labels = [];
  if (bar.isRecoveryWeek) labels.push("调整周");
  if (bar.isTaperWeek) labels.push("减量周");
  const suffix = labels.length > 0 ? ` · ${labels.join(" · ")}` : "";
  const planned = bar.source === "actual" ? ` · 计划 ${formatKm(bar.plannedKm)}` : "";
  return `W${padWeek(bar.week)} ${source} ${formatKm(bar.source === "actual" ? bar.actualKm : bar.displayKm)}${planned} · ${bar.phase.name}${suffix}`;
}

export function mileageBarFillColor(bar: MileageBar, visual: PhaseVisual): string {
  if (bar.isCurrent || bar.source === "actual") return visual.color;
  if (bar.isRecoveryWeek) return `color-mix(in oklab, ${visual.color} 28%, var(--surface))`;
  if (bar.isTaperWeek) return `color-mix(in oklab, ${visual.color} 34%, var(--surface))`;
  return `color-mix(in oklab, ${visual.color} 42%, var(--surface))`;
}

export function formatWeekDateRange(start: string, end: string | null): string {
  return end ? `${formatShort(start)}-${formatShort(end)}` : formatShort(start);
}
