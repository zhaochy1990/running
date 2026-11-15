import assert from "node:assert/strict";
import test from "node:test";
import { buildComparisons, distanceBlock } from "./comparisons.js";
import type { Evidence, Snapshot } from "./types.js";

function activity(id: string, content: Record<string, unknown>): Evidence {
  return {
    id,
    revision: "one",
    kind: "activity",
    eventTime: null,
    reportedAt: null,
    active: true,
    content: { name: "示例市 跑步", sport: "run_outdoor", shanghaiDay: "2026-11-01", provider: "coros", ascentM: 0, ...content },
  };
}
const snapshot = (evidence: Evidence[]): Snapshot => ({
  userId: "one",
  startDay: "2026-05-20",
  endDay: "2026-11-15",
  capturedAt: "2026-11-15T12:00:00Z",
  coverage: {},
  evidence,
});

test("distance blocks include partial boundary laps and weight heart rate by time", () => {
  const row = activity("one", {
    laps: [
      { lapIndex: 1, distanceM: 5000, durationS: 1500, avgHr: 140 },
      { lapIndex: 2, distanceM: 5000, durationS: 1200, avgHr: 160 },
    ],
  });
  assert.deepEqual(distanceBlock(row, 2500, 7500), { startKm: 2.5, endKm: 7.5, paceSKm: 270, hr: 148.9 });
  assert.equal(distanceBlock(row, 0, 12000), null);
  assert.equal(distanceBlock(row, 5000, 1000), null);
});

test("coarse or incomplete long-run segments cannot masquerade as ten-kilometre observations", () => {
  const row = activity("coarse", {
    distanceM: 30000,
    durationS: 9000,
    laps: [
      { lapIndex: 1, distanceM: 27000, durationS: 8100, avgHr: 150 },
      { lapIndex: 2, distanceM: 3000, durationS: 900, avgHr: 150 },
    ],
  });
  const result = buildComparisons(snapshot([row]));
  assert.equal(result.diagnostics.selectedLongRuns, 0);
  assert.deepEqual(result.diagnostics.excludedLongRuns, ["coarse"]);
  assert(!result.observations.some((o) => o.id === "comparison-long-run-execution"));
});

test("weather pairing does not reuse activities or discard counterexamples", () => {
  const rows = [
    activity("hot-one", { shanghaiDay: "2026-11-01", distanceM: 10000, avgPaceSKm: 300, avgHr: 130, feelsLike: 30, strideSessionClass: "easy" }),
    activity("cool-one", { shanghaiDay: "2026-11-03", distanceM: 10000, avgPaceSKm: 301, avgHr: 150, feelsLike: 20, strideSessionClass: "easy" }),
    activity("hot-two", { shanghaiDay: "2026-11-05", distanceM: 10000, avgPaceSKm: 302, avgHr: 160, feelsLike: 30, strideSessionClass: "easy" }),
    activity("cool-two", { shanghaiDay: "2026-11-07", distanceM: 10000, avgPaceSKm: 302, avgHr: 140, feelsLike: 20, strideSessionClass: "easy" }),
  ];
  const result = buildComparisons(snapshot(rows));
  const comparison = result.observations.find((o) => o.id === "comparison-weather");
  assert(comparison);
  assert.equal(result.diagnostics.selectedWeatherPairs, 2);
  assert.equal(new Set(comparison.evidence.map((r) => r.id)).size, 4);
  assert.match(comparison.text, /-20/);
  assert.match(comparison.text, /\+20/);
});
