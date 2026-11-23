// Route-thumbnail decoding and stroke width for `RouteThumbnail`
// (devops#1040, epic devops#1034). The wire formats and the width formula are
// owned by Go (`src/go/internal/thumbnail/route_v2.go`: EncodeV2 and
// StrokeWidth); this file carries only what the Web client needs to draw them.

import type { RouteShapeV2 } from "../api";

/** Width metrics of a v2 route shape, as the API sends them (see `RouteShapeV2`). */
export type RouteWidthMetrics = Pick<RouteShapeV2, "short" | "long" | "travel">;

/** What the thumbnail draws: one polyline per stroke in time order, and where the run really started and ended. */
export interface DecodedRouteThumb {
  strokes: number[][][];
  start: number[];
  end: number[];
  /** null for a legacy single polyline, which has no metrics. */
  metrics: RouteWidthMetrics | null;
}

function isPoint(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 2 && value.every((c) => typeof c === "number");
}

// The server validates a shape before it stores one, but the client still has
// to cope with whatever a row holds: every check here is a value the renderer
// would index into or compute with.
function isShapeV2(value: unknown): value is RouteShapeV2 {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as Record<string, unknown>;
  return (
    shape.v === 2 &&
    Array.isArray(shape.strokes) &&
    shape.strokes.length > 0 &&
    shape.strokes.every((stroke) => Array.isArray(stroke) && stroke.length >= 2 && stroke.every(isPoint)) &&
    isPoint(shape.start) &&
    isPoint(shape.end) &&
    [shape.short, shape.long, shape.travel].every((metric) => typeof metric === "number")
  );
}

/**
 * Tells the three generations that share `route_thumb` apart and returns what
 * to draw, or null when there is nothing to draw: null (no GPS), or a shape
 * this client cannot read, for which the caller shows the sport placeholder.
 */
export function decodeRouteThumb(raw: unknown): DecodedRouteThumb | null {
  // Legacy v1: a single polyline of [x, y] points.
  if (Array.isArray(raw)) {
    return raw.length >= 2 && raw.every(isPoint) ? { strokes: [raw], start: raw[0], end: raw[raw.length - 1], metrics: null } : null;
  }
  // v2: the versioned multi-stroke object.
  if (isShapeV2(raw)) {
    return { strokes: raw.strokes, start: raw.start, end: raw.end, metrics: { short: raw.short, long: raw.long, travel: raw.travel } };
  }
  return null;
}

/**
 * Stroke width in logical px for a v2 shape shown `displaySize` logical px
 * wide — a port of Go `thumbnail.StrokeWidth`. Only a narrow route that was
 * travelled back and forth thins, and only below 56 px, by at most a quarter;
 * a larger display always gets the regular width, displaySize / 30.
 */
export function routeStrokeWidth(displaySize: number, metrics: RouteWidthMetrics): number {
  const regular = displaySize / 30;
  if (metrics.short <= 0 || metrics.long <= 0) return regular;
  const narrow = clamp01((0.23 - metrics.short / metrics.long) / 0.1);
  const repeat = clamp01((metrics.travel / metrics.long - 1.5) / 0.5);
  const weight = clamp01((56 - displaySize) / 20) * narrow * repeat;
  return regular * (1 - 0.25 * weight);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
