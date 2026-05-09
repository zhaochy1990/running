import gcoord from 'gcoord'

// COROS returns WGS84; AMap renders in GCJ02 (China-mandated偏移). Skipping
// this transform leaves the polyline ~300-500m off in mainland China —
// verified 2026-05-09 against ground-truth start point. See project memory
// `project_coros_gps_coordinate_system`.
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  return gcoord.transform([lng, lat], gcoord.WGS84, gcoord.GCJ02) as [number, number]
}

// Batch transform — AMap.Polyline takes [[lng, lat], ...] tuples.
export function pointsWgs84ToGcj02(points: Array<[number, number]>): Array<[number, number]> {
  return points.map(([lng, lat]) => wgs84ToGcj02(lng, lat))
}
