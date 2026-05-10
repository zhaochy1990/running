// Tiny SVG route thumbnail for activity-list rows.
//
// The polyline is pre-computed server-side (see `compute_route_thumbnail`
// in stride_core/db.py) — each point is [x, y] in a 0..100 viewport with
// Y already flipped. Indoor / strength / GPS-failed activities pass
// `polyline = null` and the component renders a sport-icon placeholder
// instead.

interface Props {
  polyline: number[][] | null | undefined
  // Sport name (zh-CN or en) so the placeholder branch can pick the
  // right icon. We treat anything that isn't running/cycling as a
  // generic "non-route" activity.
  sportName?: string
  size?: number    // pixel size of the square thumbnail; default 56
  color?: string   // polyline color; default accent-green
}

const DEFAULT_COLOR = '#00a85a'

function isStrengthSport(name: string | undefined): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return /strength|力量|gym|hiit|tennis|jump rope|跳绳|网球/i.test(lower)
}

export default function RouteThumbnail({
  polyline,
  sportName,
  size = 56,
  color = DEFAULT_COLOR,
}: Props) {
  // No polyline = no GPS data. Show a minimal sport-typed placeholder
  // instead of an empty box so the row still has visual rhythm.
  if (!polyline || polyline.length < 2) {
    const isStrength = isStrengthSport(sportName)
    return (
      <div
        className="flex items-center justify-center bg-bg-subtle rounded-lg shrink-0"
        style={{ width: size, height: size }}
        aria-label={isStrength ? '力量训练' : '室内活动'}
      >
        <svg viewBox="0 0 24 24" width={size * 0.5} height={size * 0.5} fill="none">
          {isStrength ? (
            // Dumbbell glyph
            <path
              d="M4 9v6m4-9v12m8-12v12m4-9v6M9 12h6"
              stroke="#8888a0"
              strokeWidth="2"
              strokeLinecap="round"
            />
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
    )
  }

  const points = polyline.map(([x, y]) => `${x},${y}`).join(' ')
  return (
    <div
      className="bg-bg-subtle rounded-lg shrink-0 overflow-hidden"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} preserveAspectRatio="xMidYMid meet">
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Start marker (first point) */}
        <circle cx={polyline[0][0]} cy={polyline[0][1]} r="3" fill={color} />
        {/* End marker (last point) — small filled black dot */}
        <circle
          cx={polyline[polyline.length - 1][0]}
          cy={polyline[polyline.length - 1][1]}
          r="3"
          fill="#1a1c2e"
        />
      </svg>
    </div>
  )
}
