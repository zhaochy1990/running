import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ContextSnapshot, ContextSnapshotSchema } from "../context.js";
import { buildPhaseEvidence, type PhaseEvidence, type PhasingActivityInput } from "./evidence.js";

/**
 * 三运动员冻结 fixture 加载（as_of 2026-10-26，devops#782 F 节回放基线；
 * 单测与真模型回放脚本共用）。数据形状与生产 DataProvider 投影一致：
 * snapshot 走 ContextSnapshotSchema，活动行为 snake_case 导出（此处映射）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "fixtures");

export const AS_OF = "2026-10-26";

export const ATHLETES = {
  chaoyi: { targetTime: "2:50:00", weeklyRunDaysMax: 6 },
  dingchentao: { targetTime: "2:47:00", weeklyRunDaysMax: 7 },
  pan: { targetTime: "3:40:00", weeklyRunDaysMax: 5 },
} as const;
export type AthleteName = keyof typeof ATHLETES;

interface FixtureActivityRow {
  date: string;
  name: string | null;
  distance_m: number | null;
  stride_session_class: string | null;
}

export async function loadAthlete(name: AthleteName): Promise<{ snapshot: ContextSnapshot; activities: PhasingActivityInput[] }> {
  const dir = resolve(FIXTURES, name);
  const snapshot = ContextSnapshotSchema.parse(JSON.parse(await readFile(resolve(dir, "snapshot.json"), "utf8")));
  const rows = JSON.parse(await readFile(resolve(dir, "activities-2026.json"), "utf8")) as FixtureActivityRow[];
  return {
    snapshot,
    activities: rows.map((r) => ({ date: r.date, name: r.name, distanceM: r.distance_m, strideSessionClass: r.stride_session_class })),
  };
}

export async function buildAthleteEvidence(name: AthleteName, raceName = "无锡马拉松"): Promise<PhaseEvidence> {
  const { snapshot, activities } = await loadAthlete(name);
  const spec = ATHLETES[name];
  return buildPhaseEvidence(snapshot, activities, { raceName, distance: "FM", targetTime: spec.targetTime, weeklyRunDaysMax: spec.weeklyRunDaysMax }, AS_OF);
}

/** 伤退场景变换（回放脚本专用）：近 6 周量砍半、停训 3 周——改证据不改跑道。 */
export function applyInjuryScenario(evidence: PhaseEvidence): PhaseEvidence {
  const pre = evidence.recent_volume.recent_peak_week_km;
  const halved = Math.max(10, Math.round(pre * 0.45));
  return {
    ...evidence,
    recent_volume: {
      ...evidence.recent_volume,
      avg_4wk_km: halved * 0.8,
      avg_8wk_km: Math.round(((evidence.recent_volume.avg_8wk_km * 4 + halved * 0.8 * 4) / 8) * 10) / 10,
      recent_peak_week_km: halved,
      longest_run_8wk_km: Math.min(evidence.recent_volume.longest_run_8wk_km, 16),
      gap_weeks_last16: evidence.recent_volume.gap_weeks_last16 + 3,
    },
    injuries: [{ body_area: "膝髂胫束", status: "active; restriction=partial" }],
    injury_return: { pre_injury_peak_week_km: pre, weeks_out: 3 },
  };
}
