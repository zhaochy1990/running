import type { RouteShapeV2 } from "../api";

// Route shapes as the activity list API serves them, for the thumbnail tests.
// The v2 payloads were written by the Go encoder these clients read
// (`src/go/internal/thumbnail` EncodeV2) for synthetic traces — real user
// routes are never committed (epic devops#1034).

/** A loop with a side street across it: two strokes sharing the two junction vertices. */
export const LOOP_WITH_SIDE_STREET: RouteShapeV2 = {
  v: 2,
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
  short: 60.1,
  long: 90.0,
  travel: 508.8,
};

// A narrow out-and-back: the return leg is already covered, so the one stroke
// stops at the turnaround while the run really ended back at the start.
export const NARROW_OUT_AND_BACK: RouteShapeV2 = {
  v: 2,
  strokes: [
    [
      [5.0, 50.4],
      [95.0, 50.4],
      [95.0, 49.6],
    ],
  ],
  start: [5.0, 50.4],
  end: [5.0, 50.4],
  short: 1.0,
  long: 90.0,
  travel: 180.0,
};

/** A legacy single polyline: the shape of a row that has not been recomputed. */
export const LEGACY_POLYLINE = [
  [5.0, 95.0],
  [50.0, 20.0],
  [95.0, 5.0],
];
