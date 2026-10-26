import type { PhaseEvidence } from "./evidence.js";
import { PhaseEvidenceSchema } from "./evidence.js";
import type { GateCheck } from "./gates.js";
import type { PhaseCanonical, PhaseDivisionIntent } from "./intent.js";
import { PhaseDivisionIntentSchema } from "./intent.js";

/** 可控合成证据：avg8=60 / peak8=80 → 峰值帽 min(120, max(96,104))=104。 */
export function makeEvidence(overrides: Partial<PhaseEvidence> = {}): PhaseEvidence {
  const base = {
    as_of: "2026-10-26",
    target: { race: "全程马拉松 无锡马拉松", target_time: "3:00:00", goal_pace: "4:16/km", improvement_pct: null },
    personal_bests: { FM: "3:12:00", HM: "1:30:00" },
    peak_fm_pb: { time_sec: 11520, achieved_at: "2026-03-22" },
    current_capability: {
      vdot: 50,
      equivalents: { "5K": 1196, "10K": 2480, HM: 5491, FM: 11440 },
      source: "recent_race_hm_fm",
      source_date: "2026-09-20",
      confidence: "high",
      pace_zones: null,
    },
    fitness: { ctl: 55, atl: 50, form: 5 },
    availability: { weekly_run_days_max: 6 },
    recent_volume: { avg_8wk_km: 60, avg_4wk_km: 65, recent_peak_week_km: 80, longest_run_8wk_km: 25, gap_weeks_last16: 0 },
    monthly_focus: [],
    phase_credit: {
      sustained_volume_months_ge40wk: 2,
      e_share_months_ge85: 3,
      months_with_long_run_ge25: 2,
      months_with_ge4_quality: 1,
      marathons_since_april: 1,
    },
    last_race: { date: "2026-09-20", distance_km: 35, days_ago: 36 },
    injuries: [],
    injury_return: null,
    evidence_note: "test",
  };
  return PhaseEvidenceSchema.parse({ ...base, ...overrides });
}

export function phase(
  canonical: PhaseCanonical,
  start: number,
  end: number,
  extra: Partial<PhaseDivisionIntent["phases"][number]> = {},
): PhaseDivisionIntent["phases"][number] {
  return {
    canonical,
    name: canonical,
    start_week: start,
    end_week: end,
    primary_goal:
      canonical === "recovery"
        ? "recovery"
        : canonical === "foundation"
          ? "aerobic_base"
          : canonical === "early_quality"
            ? "speed"
            : canonical === "transition_quality"
              ? "threshold"
              : "race_specificity",
    training_goal: "目标",
    block_mode:
      canonical === "recovery" ? "light" : canonical === "foundation" ? "progressive" : canonical === "final_quality" ? "plateau" : "progressive_quality",
    rationale: `近 8 周 60km，CTL 55，月度有氧学分 2 个月 ≥40km`,
    ...extra,
  };
}

export const allPass = (checks: Array<{ pass: boolean }>) => checks.every((c) => c.pass);

/** N=22 全绿基底：recovery2 + foundation6 + early2 + transition5 + final7（taper3）。 */
export function makeIntent(overrides: {
  phases?: PhaseDivisionIntent["phases"];
  taperWeeks?: number;
  milestones?: PhaseDivisionIntent["milestones"];
  gates?: PhaseDivisionIntent["gates"];
  volumeBands?: PhaseDivisionIntent["volume_bands"];
}): PhaseDivisionIntent {
  return PhaseDivisionIntentSchema.parse({
    phases: overrides.phases ?? [
      phase("recovery", 1, 2),
      phase("foundation", 3, 8),
      phase("early_quality", 9, 10),
      phase("transition_quality", 11, 15),
      phase("final_quality", 16, 22),
    ],
    taper_weeks: overrides.taperWeeks ?? 3,
    milestones: overrides.milestones ?? [
      { phase: "recovery", signal: "HRV", criterion: "HRV 回基线" },
      { phase: "foundation", signal: "long_run_km", criterion: "25km 长跑两周无不适" },
      { phase: "early_quality", signal: "质量课计数", criterion: "R 课完成 2 周" },
      { phase: "transition_quality", signal: "T 配速课完成度", criterion: "2 节 T 课 48h 恢复" },
      { phase: "final_quality", signal: "M 配速课", criterion: "30km M 配速彩排" },
    ],
    gates: overrides.gates ?? [
      { phase: "foundation", signal: "weekly_km", criterion: "周量达下限", action_if_missed: "延长一周并下调长跑" },
      { phase: "transition_quality", signal: "体感 RPE", criterion: "课后 48h ≤6", action_if_missed: "重复上一块块位" },
    ],
    volume_bands: overrides.volumeBands ?? [
      { phase: "recovery", weekly_km_min: 20, weekly_km_max: 44 },
      { phase: "foundation", weekly_km_min: 40, weekly_km_max: 70 },
      { phase: "early_quality", weekly_km_min: 50, weekly_km_max: 90 },
      { phase: "transition_quality", weekly_km_min: 55, weekly_km_max: 95 },
      { phase: "final_quality", weekly_km_min: 60, weekly_km_max: 100 },
    ],
  });
}

export const failing = (checks: GateCheck[], id: string) => checks.find((c) => c.id.startsWith(id));
