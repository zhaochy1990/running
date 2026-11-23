import { describe, expect, it } from "vitest";

import { LEGACY_POLYLINE, LOOP_WITH_SIDE_STREET } from "../../test/routeThumbFixtures";
import { decodeRouteThumb, routeStrokeWidth } from "../routeThumb";

describe("decodeRouteThumb", () => {
  it("reads a v2 shape: its strokes, the real start and end, and the width metrics", () => {
    expect(decodeRouteThumb(LOOP_WITH_SIDE_STREET)).toEqual({
      strokes: [
        [
          [5.1, 79.9],
          [50.0, 79.9],
          [94.9, 79.9],
          [94.9, 20.1],
          [50.0, 20.1],
          [5.1, 20.1],
          [5.1, 79.9],
        ],
        [
          [50.0, 79.9],
          [50.0, 20.1],
        ],
      ],
      start: [5.1, 79.9],
      end: [5.1, 79.9],
      metrics: { short: 60.1, long: 90.0, travel: 508.8 },
    });
  });

  it("reads the legacy single polyline as one stroke that starts and ends where the polyline does", () => {
    expect(decodeRouteThumb(LEGACY_POLYLINE)).toEqual({
      strokes: [
        [
          [5, 95],
          [50, 20],
          [95, 5],
        ],
      ],
      start: [5, 95],
      end: [95, 5],
      metrics: null,
    });
  });

  it.each([
    ["no GPS", null],
    ["a missing field", undefined],
    ["an empty legacy polyline", []],
    ["a single legacy point", [[5, 95]]],
    ["a legacy point that is not a pair", [[5, 95], [50]]],
    ["a version this client does not know", { ...LOOP_WITH_SIDE_STREET, v: 3 }],
    ["a v2 object without strokes", { ...LOOP_WITH_SIDE_STREET, strokes: undefined }],
    ["a v2 object with no strokes", { ...LOOP_WITH_SIDE_STREET, strokes: [] }],
    ["a v2 object with a one-point stroke", { ...LOOP_WITH_SIDE_STREET, strokes: [[[5, 5]]] }],
    ["a v2 object with a stroke point that is not a pair", { ...LOOP_WITH_SIDE_STREET, strokes: [[[5, 5], null]] }],
    ["a v2 object without an endpoint", { ...LOOP_WITH_SIDE_STREET, start: null }],
    ["a v2 object with a non-numeric metric", { ...LOOP_WITH_SIDE_STREET, short: "narrow" }],
  ])("has nothing to draw for %s", (_label, raw) => {
    expect(decodeRouteThumb(raw)).toBeNull();
  });
});

// The same cases as Go `thumbnail.TestStrokeWidth`; the expected widths are the
// epic's numbers (1.20 px regular and 0.90 px thin on a 36 px slot).
describe("routeStrokeWidth", () => {
  it.each([
    ["36 px regular", 36, { short: 60, long: 90, travel: 300 }, 1.2],
    ["36 px thin: narrow and travelled back and forth", 36, { short: 8, long: 90, travel: 260 }, 0.9],
    ["56 px is back to the regular width", 56, { short: 8, long: 90, travel: 260 }, 1.8667],
    ["64 px and up never thin", 64, { short: 8, long: 90, travel: 260 }, 2.1333],
    ["a straight-line trace never thins", 36, { short: 0, long: 90, travel: 300 }, 1.2],
    ["a short route does not thin", 36, { short: 20, long: 90, travel: 100 }, 1.2],
  ])("%s", (_label, displaySize, metrics, want) => {
    expect(routeStrokeWidth(displaySize, metrics)).toBeCloseTo(want, 4);
  });
});
