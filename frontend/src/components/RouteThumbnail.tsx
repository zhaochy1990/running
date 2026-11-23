// Tiny SVG route thumbnail for activity-list rows.
//
// The shape is pre-computed server-side (Go `internal/thumbnail`, stored in
// activities.route_thumb_json) and reaches the component as one of three
// generations through the activity list API (devops#1037): the v2 multi-stroke
// object, the legacy single polyline for rows not yet recomputed, or null when
// the activity has no GPS. `decodeRouteThumb` tells them apart. Every point is
// [x, y] in a 0..100 viewport with Y already flipped.

import type { RouteThumb } from "../api";
import { decodeRouteThumb, routeStrokeWidth } from "../lib/routeThumb";

interface Props {
  routeThumb: RouteThumb | null | undefined;
  // Sport name (zh-CN or en) so the placeholder branch can pick the
  // right icon. We treat anything that isn't running/cycling as a
  // generic "non-route" activity.
  sportName?: string;
  size?: number; // pixel size of the square thumbnail; default 56
  color?: string; // stroke color; default accent-green
}

const DEFAULT_COLOR = "#00a85a";
// Viewbox units: the established weight of a legacy single polyline.
const LEGACY_STROKE_WIDTH = 3;

function isStrengthSport(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return /strength|力量|gym|hiit|tennis|jump rope|跳绳|网球/i.test(lower);
}

export default function RouteThumbnail({ routeThumb, sportName, size = 56, color = DEFAULT_COLOR }: Props) {
  const shape = decodeRouteThumb(routeThumb);

  // No shape = no GPS data. Show a minimal sport-typed placeholder
  // instead of an empty box so the row still has visual rhythm.
  if (!shape) {
    const isStrength = isStrengthSport(sportName);
    return (
      <div
        className="flex items-center justify-center bg-bg-subtle rounded-lg shrink-0"
        style={{ width: size, height: size }}
        aria-label={isStrength ? "力量训练" : "室内活动"}
      >
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none">
          {isStrength ? (
            // Dumbbell glyph
            <path d="M4 9v6m4-9v12m8-12v12m4-9v6M9 12h6" stroke="#8888a0" strokeWidth="2" strokeLinecap="round" />
          ) : (
            // Generic running figure
            <path
              d="M13 4a2 2 0 11-4 0 2 2 0 014 0zM7 22l2-7 3 2v5M9 14l-2-3 5-3 3 4 3 1"
              stroke="#8888a0"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </div>
    );
  }

  // A v2 shape carries the metrics to thin a narrow out-and-back at small
  // sizes; a legacy polyline keeps its established weight. The svg maps 100
  // viewbox units onto `size` px, so px become units through 100 / size.
  const strokeWidth = shape.metrics ? (routeStrokeWidth(size, shape.metrics) * 100) / size : LEGACY_STROKE_WIDTH;
  return (
    <div className="bg-bg-subtle rounded-lg shrink-0 overflow-hidden" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} preserveAspectRatio="xMidYMid meet">
        {/* One path per stroke: strokes only meet where they share a vertex. */}
        {shape.strokes.map((stroke, i) => (
          <polyline
            key={i}
            points={stroke.map(([x, y]) => `${x},${y}`).join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {/* Start marker (the run's real first fix) */}
        <circle cx={shape.start[0]} cy={shape.start[1]} r="3" fill={color} />
        {/* End marker (the run's real last fix) — small filled dark dot */}
        <circle cx={shape.end[0]} cy={shape.end[1]} r="3" fill="#1a1c2e" />
      </svg>
    </div>
  );
}
