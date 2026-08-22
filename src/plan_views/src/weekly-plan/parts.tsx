import type { PlannedSession } from "../types";

export interface WeeklyPlanActions {
  /** Navigate to the coach adjust flow for this week. */
  onAdjust?: () => void;
  canPushRun?: boolean;
  canPushStrength?: boolean;
  /** Push a single planned session (by its `session_index`) to the wearable/calendar. */
  onPushSession?: (sessionIndex: number) => void | Promise<void>;
  /** Push all planned sessions for the week. */
  onPushAll?: () => void | Promise<void>;
  /** Persist edited weekly feedback. */
  onSaveFeedback?: (text: string) => void | Promise<void>;
}

export const kindLabel: Record<PlannedSession["kind"], string> = {
  run: "跑步",
  strength: "力量",
  rest: "休息",
  cross: "交叉训练",
  note: "说明",
};

export const kindStyle: Record<PlannedSession["kind"], string> = {
  run: "bg-green-soft text-accent-green",
  strength: "bg-purple-soft text-accent-purple",
  rest: "bg-bg-secondary text-text-muted",
  cross: "bg-cyan-soft text-accent-cyan",
  note: "bg-amber-soft text-accent-amber",
};

export function MetricSmall({ label, value }: { label: string; value: string }) {
  return (
    <div className="hidden rounded-xl border border-border-subtle bg-bg-card px-4 py-2.5 sm:block">
      <p className="font-mono text-[10px] tracking-wider text-text-muted">{label}</p>
      <p className="mt-1 font-mono text-lg font-bold text-text-primary">{value}</p>
    </div>
  );
}

export function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-bg-secondary p-3">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className={"mt-1 font-mono text-sm font-bold " + (accent ? "text-accent-green" : "text-text-primary")}>{value}</p>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-border bg-bg-card py-16 text-center text-sm text-text-muted">{text}</div>;
}

export function InfoCard({ title, text, amber = false }: { title: string; text: string; amber?: boolean }) {
  return (
    <div className={"rounded-xl border p-5 " + (amber ? "border-accent-amber/30 bg-amber-soft" : "border-border-subtle bg-bg-card shadow-sm")}>
      <h3 className={"text-sm font-bold " + (amber ? "text-accent-amber" : "text-text-primary")}>{title}</h3>
      <p className="mt-3 text-xs leading-5 text-text-secondary">{text}</p>
    </div>
  );
}

export function QualityCard({ label }: { label: string }) {
  return (
    <div className="rounded-xl bg-bg-secondary p-4">
      <p className="text-xs font-bold text-text-muted">{label}</p>
      <p className="mt-2 font-mono text-2xl font-bold text-text-muted">—</p>
    </div>
  );
}
