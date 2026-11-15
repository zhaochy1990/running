import assert from "node:assert/strict";
import test from "node:test";
import { activityHabits, blockMeasurements } from "./measurements.js";
import type { Evidence, Snapshot } from "./types.js";

const e = (id: string, content: Record<string, unknown>): Evidence => ({
  id,
  kind: "activity",
  revision: "r1",
  active: true,
  eventTime: null,
  reportedAt: null,
  content: { sport: "run_outdoor", shanghaiDay: "2026-11-15", ...content },
});
const s = (rows: Evidence[]): Snapshot => ({
  userId: "one",
  startDay: "2026-11-01",
  endDay: "2026-11-15",
  capturedAt: "2026-11-15T00:00:00Z",
  coverage: {},
  evidence: rows,
});
test("predefined block verification uses actual distance boundaries, excludes coarse laps and keeps raw precision", () => {
  const good = e("good", {
    distanceM: 30000,
    durationS: 9069.3,
    laps: [
      { lapIndex: 1, distanceM: 10000, durationS: 3000 },
      { lapIndex: 2, distanceM: 10000, durationS: 3000 },
      { lapIndex: 3, distanceM: 10000, durationS: 3069.3 },
    ],
  });
  // Split the 10km laps into 5km canonical segments to meet the measurement limit.
  good.content.laps = [3000, 3000, 3069.3].flatMap((t, i) => [
    { lapIndex: i * 2 + 1, distanceM: 5000, durationS: t / 2 },
    { lapIndex: i * 2 + 2, distanceM: 5000, durationS: t / 2 },
  ]);
  const coarse = e("coarse", {
    distanceM: 30000,
    durationS: 9000,
    laps: [
      { lapIndex: 1, distanceM: 25000, durationS: 7500 },
      { lapIndex: 2, distanceM: 5000, durationS: 1500 },
    ],
  });
  const rows = blockMeasurements(s([good, coarse]), 25);
  const result = rows.find((r) => r.sourceId === "good");
  assert.ok(result?.eligible);
  assert.ok(result.halfChangePct !== undefined && result.halfChangePct !== null);
  assert(Math.abs(result.halfChangePct - 1.54) < 1e-8);
  assert(result.halfChangePct > 1.5);
  assert.equal(rows.find((r) => r.sourceId === "coarse")?.eligible, false);
});
test("habit intervals classify raw minutes before rounding and exclude non-running sports", () => {
  const rows = [
    e("a", { date: "2026-11-15T00:00:00Z", durationS: 600, distanceM: 3000 }),
    e("b", { date: "2026-11-15T00:39:36Z", durationS: 600, distanceM: 3000 }),
    e("c", { date: "2026-11-15T01:19:12Z", durationS: 600, distanceM: 3000 }),
    e("swim", { sport: "swim", date: "2026-11-15T02:00:00Z", durationS: 600 }),
  ];
  const result = activityHabits(s(rows));
  assert.equal(result.runs, 3);
  assert.equal(result.pairs, 2);
  assert.equal(result.gapUnder30Minutes, 2);
  assert.equal(result.medianGapMinutes, 29.6);
});

test("aggregate lap tolerance cannot mark incomplete requested blocks as eligible", () => {
  const incomplete = e("short-laps", {
    distanceM: 30000,
    durationS: 9000,
    laps: [5000, 5000, 5000, 5000, 5000, 4500].map((distanceM, i) => ({ lapIndex: i + 1, distanceM, durationS: distanceM * 0.3 })),
  });
  const [result] = blockMeasurements(s([incomplete]), 25);
  assert.equal(result?.eligible, false);
  assert.match(result?.reason ?? "", /fully cover/);
});
