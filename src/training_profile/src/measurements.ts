/** Fixed verification methods. Classification always uses unrounded values. */
import { shanghaiIso } from "@stride/contract";
import { activityCityLabel, distanceBlock, supportsDistanceBlocks } from "./comparisons.js";
import { finite, runningEvidence, type Snapshot } from "./types.js";

const median = (v: number[]) => {
  const a = v.toSorted((x, y) => x - y);
  return a.length ? ((a[Math.floor((a.length - 1) / 2)] ?? 0) + (a[Math.floor(a.length / 2)] ?? 0)) / 2 : null;
};

export function blockMeasurements(snapshot: Snapshot, minimumDistanceKm: number) {
  return runningEvidence(snapshot)
    .filter((e) => (finite(e.content.distanceM) ?? -1) >= minimumDistanceKm * 1000)
    .map((e) => {
      const d = Number(e.content.distanceM),
        duration = finite(e.content.durationS);
      if (!supportsDistanceBlocks(e))
        return { sourceId: e.id, day: e.content.shanghaiDay, distanceM: d, eligible: false, reason: "coarse/incomplete canonical laps" };
      const first = distanceBlock(e, 0, 10000, false),
        last = distanceBlock(e, d - 10000, d, false),
        a = distanceBlock(e, 0, d / 2, false),
        b = distanceBlock(e, d / 2, d, false),
        last5 = distanceBlock(e, d - 5000, d, false);
      if (!first || !last || !a || !b || !last5)
        return { sourceId: e.id, day: e.content.shanghaiDay, distanceM: d, eligible: false, reason: "canonical laps do not fully cover the requested blocks" };
      return {
        sourceId: e.id,
        day: e.content.shanghaiDay,
        distanceM: d,
        eligible: true,
        first10: first,
        last10: last,
        firstHalf: a,
        lastHalf: b,
        last5,
        last10ChangePct: first && last ? (last.paceSKm / first.paceSKm - 1) * 100 : null,
        halfChangePct: a && b ? (b.paceSKm / a.paceSKm - 1) * 100 : null,
        last5VsWholePct: last5 && duration ? (last5.paceSKm / ((duration / d) * 1000) - 1) * 100 : null,
      };
    });
}

export function activityHabits(snapshot: Snapshot) {
  const runs = runningEvidence(snapshot),
    days = new Map<string, typeof runs>();
  const cities = new Map<string, { records: number; morning4to10: number; evening18plus: number }>();
  for (const e of runs) {
    const day = String(e.content.shanghaiDay);
    const list = days.get(day) ?? [];
    list.push(e);
    days.set(day, list);
    if (typeof e.content.date !== "string" || !Number.isFinite(Date.parse(e.content.date))) continue;
    const label = activityCityLabel(e) ?? "unknown_label",
      hour = Number(shanghaiIso(e.content.date).slice(11, 13));
    const c = cities.get(label) ?? { records: 0, morning4to10: 0, evening18plus: 0 };
    c.records++;
    if (hour >= 4 && hour < 10) c.morning4to10++;
    if (hour >= 18) c.evening18plus++;
    cities.set(label, c);
  }
  const pairs: Array<{ first: string; second: string; day: string; gapMinutes: number; bothAtLeast2km: boolean }> = [];
  for (const [day, rows] of days) {
    const timed = rows
      .filter((e) => typeof e.content.date === "string" && Number.isFinite(Date.parse(e.content.date)) && finite(e.content.durationS) !== null)
      .toSorted((a, b) => Date.parse(String(a.content.date)) - Date.parse(String(b.content.date)));
    for (let i = 1; i < timed.length; i++) {
      const a = timed[i - 1],
        b = timed[i];
      if (!a || !b) continue;
      const gap = (Date.parse(String(b.content.date)) - Date.parse(String(a.content.date)) - Number(a.content.durationS) * 1000) / 60000;
      pairs.push({
        first: a.id,
        second: b.id,
        day,
        gapMinutes: gap,
        bothAtLeast2km: Number(a.content.distanceM) >= 2000 && Number(b.content.distanceM) >= 2000,
      });
    }
  }
  return {
    runs: runs.length,
    runDays: days.size,
    multipleRecordDays: [...days.values()].filter((v) => v.length > 1).length,
    pairs: pairs.length,
    medianGapMinutes: median(pairs.map((p) => p.gapMinutes)),
    gapUnder30Minutes: pairs.filter((p) => p.gapMinutes < 30).length,
    separated2kmPairs: pairs.filter((p) => p.gapMinutes >= 180 && p.bothAtLeast2km),
    cities: [...cities].map(([label, c]) => ({ label, ...c })),
    method:
      "Known running sports only; Shanghai day from provider; start→estimated end uses durationS; no rounding before comparisons. Temporal adjacency is a clue, not proof of one session; city text is a label, not GPS or stated preference.",
  };
}
