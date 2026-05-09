import { useEffect, useMemo, useRef, useState } from 'react'
import { useAMap } from './useAMap'
import { wgs84ToGcj02 } from './coordTransform'
import type { TimeseriesPoint, Pause } from '../../api'

// AMap doesn't ship public TS types with the loader; work with `any` at the
// SDK boundary and isolate it inside this file.
/* eslint-disable @typescript-eslint/no-explicit-any */

const COLOR_GREEN = '#00a85a'      // accent-green
const COLOR_AMBER = '#e68a00'      // accent-amber
const COLOR_RED = '#d32f2f'        // accent-red
const COLOR_BORDER = '#ffffff'

type Coloring = 'none' | 'hr' | 'pace'

// Computed point with everything needed for rendering: GCJ02 coords +
// elapsed seconds + per-channel metrics. Indexes are aligned 1:1 with the
// input timeseries[] so hoverElapsed → array lookup stays trivial.
interface ComputedPoint {
  lng: number | null     // GCJ02 longitude (null when source GPS missing)
  lat: number | null
  elapsed: number        // seconds since activity start
  distance_km: number    // cumulative
  heart_rate: number | null
  speed: number | null   // raw COROS unit (s/km — lower = faster)
  altitude: number | null
}

interface RouteSegment {
  // Points belonging to this continuous segment (between pauses).
  // Indexes into the parent ComputedPoint[] array.
  startIdx: number
  endIdx: number  // inclusive
}

interface Props {
  points: TimeseriesPoint[]
  pauses: Pause[]
  startTs: number       // first non-null timeseries timestamp; matches HR/Pace charts
  hoverElapsed?: number | null
  onHover?: (elapsed: number | null) => void
  height?: number
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function paceStr(s_per_km: number | null): string {
  if (!s_per_km || s_per_km <= 0) return '—'
  const m = Math.floor(s_per_km / 60)
  const s = Math.floor(s_per_km % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Linear interpolate between two hex colors. t in [0,1].
function lerpColor(a: string, b: string, t: number): string {
  const tt = Math.max(0, Math.min(1, t))
  const ar = parseInt(a.slice(1, 3), 16)
  const ag = parseInt(a.slice(3, 5), 16)
  const ab = parseInt(a.slice(5, 7), 16)
  const br = parseInt(b.slice(1, 3), 16)
  const bg = parseInt(b.slice(3, 5), 16)
  const bb = parseInt(b.slice(5, 7), 16)
  const r = Math.round(ar + (br - ar) * tt)
  const g = Math.round(ag + (bg - ag) * tt)
  const bch = Math.round(ab + (bb - ab) * tt)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bch.toString(16).padStart(2, '0')}`
}

// 3-stop continuous gradient: green → amber → red. Both HR and pace use
// this so the user sees smooth transitions instead of zone-based jumps
// (which made a brief HR spike show up as dark-red blips on a route that
// was otherwise easy effort). Coloring is activity-relative — the same
// raw HR value maps to different colors across two activities depending
// on each activity's own min/max range.
function gradient3(t: number): string {
  const tt = Math.max(0, Math.min(1, t))
  if (tt < 0.5) return lerpColor(COLOR_GREEN, COLOR_AMBER, tt * 2)
  return lerpColor(COLOR_AMBER, COLOR_RED, (tt - 0.5) * 2)
}

export default function ActivityMap({
  points,
  pauses,
  startTs,
  hoverElapsed,
  onHover,
  height = 450,
}: Props) {
  const { AMap, error } = useAMap()
  const mapDiv = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const overlaysRef = useRef<any[]>([])
  const hoverMarkerRef = useRef<any>(null)
  const infoWindowRef = useRef<any>(null)
  const [coloring, setColoring] = useState<Coloring>('pace')

  // 1) Compute one ComputedPoint per timeseries entry. Keep null gps for
  //    unreliable points so array indexing stays aligned with hover state.
  const computed = useMemo<ComputedPoint[]>(() => {
    return points.map((p) => {
      let lng: number | null = null
      let lat: number | null = null
      if (p.gps_lat != null && p.gps_lon != null) {
        const [g_lng, g_lat] = wgs84ToGcj02(p.gps_lon, p.gps_lat)
        lng = g_lng
        lat = g_lat
      }
      const elapsed = p.timestamp != null ? Math.round((p.timestamp - startTs) / 100) : 0
      // distance from API is meters×100 (cm). Convert to km.
      const distance_km = p.distance != null ? p.distance / 100_000 : 0
      return {
        lng,
        lat,
        elapsed,
        distance_km,
        heart_rate: p.heart_rate,
        speed: p.adjusted_pace ?? p.speed,
        altitude: p.altitude,
      }
    })
  }, [points, startTs])

  // 2) Quick check: enough valid GPS to bother rendering.
  const validGpsCount = useMemo(() => computed.filter((p) => p.lng != null).length, [computed])

  // 3) Split into pause-bounded segments. Pauses ts → centiseconds since
  //    same epoch as TimeseriesPoint.timestamp, so index lookup works the
  //    same way as hover binary-search.
  const segments = useMemo<RouteSegment[]>(() => {
    if (computed.length === 0) return []
    if (!pauses || pauses.length === 0) {
      return [{ startIdx: 0, endIdx: computed.length - 1 }]
    }
    // Convert pause windows to elapsed-seconds ranges, sorted.
    const windows = pauses
      .map((p) => ({
        start: p.start_ts != null ? (p.start_ts - startTs) / 100 : null,
        end: p.end_ts != null ? (p.end_ts - startTs) / 100 : null,
      }))
      .filter((w): w is { start: number; end: number } => w.start != null && w.end != null)
      .sort((a, b) => a.start - b.start)
    if (windows.length === 0) return [{ startIdx: 0, endIdx: computed.length - 1 }]

    const segs: RouteSegment[] = []
    let segStart = 0
    let i = 0
    for (const w of windows) {
      // Walk forward until we cross the pause start.
      while (i < computed.length && computed[i].elapsed < w.start) i++
      const segEnd = i - 1
      if (segEnd >= segStart) segs.push({ startIdx: segStart, endIdx: segEnd })
      // Skip past the pause window.
      while (i < computed.length && computed[i].elapsed <= w.end) i++
      segStart = i
    }
    if (segStart < computed.length) {
      segs.push({ startIdx: segStart, endIdx: computed.length - 1 })
    }
    return segs
  }, [computed, pauses, startTs])

  // 4) Coloring bounds — activity-relative min/max for HR and pace.
  // Recomputed only when points change. Used by gradient3 to map each
  // bin's avg metric onto the green→amber→red color stops.
  const paceBounds = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const p of computed) {
      if (p.speed != null && p.speed > 0) {
        if (p.speed < min) min = p.speed
        if (p.speed > max) max = p.speed
      }
    }
    return { min: isFinite(min) ? min : 0, max: isFinite(max) ? max : 0 }
  }, [computed])

  const hrBounds = useMemo(() => {
    let min = Infinity
    let max = -Infinity
    for (const p of computed) {
      if (p.heart_rate != null && p.heart_rate > 0) {
        if (p.heart_rate < min) min = p.heart_rate
        if (p.heart_rate > max) max = p.heart_rate
      }
    }
    return { min: isFinite(min) ? min : 0, max: isFinite(max) ? max : 0 }
  }, [computed])

  // 5) Map init — once AMap loads, create the Map instance. Cleanup on unmount.
  useEffect(() => {
    if (!AMap || !mapDiv.current || mapRef.current) return
    const m = AMap as any
    const map = new m.Map(mapDiv.current, {
      zoom: 14,
      mapStyle: 'amap://styles/whitesmoke',
      viewMode: '2D',
      resizeEnable: true,
    })
    map.addControl(new m.Scale({ position: 'LB' }))
    map.addControl(new m.ToolBar({ position: 'RB' }))
    mapRef.current = map
    infoWindowRef.current = new m.InfoWindow({ offset: new m.Pixel(0, -8), isCustom: false })
    return () => {
      map.destroy()
      mapRef.current = null
      infoWindowRef.current = null
      overlaysRef.current = []
    }
  }, [AMap])

  // 6) (Re)render polylines + markers when segments / coloring changes.
  useEffect(() => {
    const map = mapRef.current
    const m = AMap as any
    if (!map || !m || segments.length === 0) return

    // Clear previous overlays.
    for (const o of overlaysRef.current) {
      try {
        o.setMap?.(null)
      } catch {
        /* ignore */
      }
    }
    overlaysRef.current = []

    const allCoords: Array<[number, number]> = []

    for (const seg of segments) {
      const segPoints: Array<{ idx: number; lng: number; lat: number }> = []
      for (let i = seg.startIdx; i <= seg.endIdx; i++) {
        const p = computed[i]
        if (p.lng != null && p.lat != null) {
          segPoints.push({ idx: i, lng: p.lng, lat: p.lat })
          allCoords.push([p.lng, p.lat])
        }
      }
      if (segPoints.length < 2) continue

      if (coloring === 'none') {
        // One polyline per segment. Click handler emits the nearest point.
        const path = segPoints.map((p) => [p.lng, p.lat])
        const line = new m.Polyline({
          path,
          strokeColor: COLOR_GREEN,
          strokeWeight: 4,
          strokeOpacity: 0.9,
          lineJoin: 'round',
          lineCap: 'round',
        })
        line.on('click', (e: any) => openPointPopup(e, segPoints))
        line.setMap(map)
        overlaysRef.current.push(line)
      } else {
        // Bin into K=200 chunks per segment (proportional to segment size).
        const K = Math.max(20, Math.min(200, Math.floor(segPoints.length / 5)))
        const step = segPoints.length / K
        for (let k = 0; k < K; k++) {
          const a = Math.floor(k * step)
          const b = Math.min(segPoints.length - 1, Math.floor((k + 1) * step))
          if (b <= a) continue
          // Compute bin metric
          let sum = 0
          let n = 0
          for (let j = a; j <= b; j++) {
            const sourceIdx = segPoints[j].idx
            const v = coloring === 'hr' ? computed[sourceIdx].heart_rate : computed[sourceIdx].speed
            if (v != null && v > 0) {
              sum += v
              n++
            }
          }
          const avg = n > 0 ? sum / n : null
          let color: string
          if (avg == null) {
            color = COLOR_GREEN
          } else if (coloring === 'hr') {
            // HR: low → green, high → red.
            const range = hrBounds.max - hrBounds.min
            const t = range > 0 ? (avg - hrBounds.min) / range : 0
            color = gradient3(t)
          } else {
            // Pace: slow (high s/km) → green; fast (low s/km) → red.
            // Inverted from HR because lower speed value = faster pace.
            const range = paceBounds.max - paceBounds.min
            const t = range > 0 ? (paceBounds.max - avg) / range : 0
            color = gradient3(t)
          }
          // Path includes overlap with neighbor bin so visual seams disappear.
          const path: Array<[number, number]> = []
          for (let j = a; j <= b; j++) path.push([segPoints[j].lng, segPoints[j].lat])
          if (b + 1 < segPoints.length) path.push([segPoints[b + 1].lng, segPoints[b + 1].lat])
          const line = new m.Polyline({
            path,
            strokeColor: color,
            strokeWeight: 4,
            strokeOpacity: 0.95,
            lineJoin: 'round',
            lineCap: 'round',
          })
          line.on('click', (e: any) => openPointPopup(e, segPoints))
          line.setMap(map)
          overlaysRef.current.push(line)
        }
      }
    }

    // Start / End markers (small dots).
    const firstSegPoint = (() => {
      for (const seg of segments) {
        for (let i = seg.startIdx; i <= seg.endIdx; i++) {
          if (computed[i].lng != null) return computed[i]
        }
      }
      return null
    })()
    const lastSegPoint = (() => {
      for (let s = segments.length - 1; s >= 0; s--) {
        const seg = segments[s]
        for (let i = seg.endIdx; i >= seg.startIdx; i--) {
          if (computed[i].lng != null) return computed[i]
        }
      }
      return null
    })()
    if (firstSegPoint && firstSegPoint.lng != null && firstSegPoint.lat != null) {
      const marker = new m.Marker({
        position: [firstSegPoint.lng, firstSegPoint.lat],
        content: `<div style="width:14px;height:14px;border-radius:50%;background:${COLOR_GREEN};border:2px solid ${COLOR_BORDER};box-shadow:0 1px 4px rgba(0,0,0,.25)"></div>`,
        anchor: 'center',
        title: '起点',
      })
      marker.setMap(map)
      overlaysRef.current.push(marker)
    }
    if (lastSegPoint && lastSegPoint.lng != null && lastSegPoint.lat != null && lastSegPoint !== firstSegPoint) {
      const marker = new m.Marker({
        position: [lastSegPoint.lng, lastSegPoint.lat],
        content: `<div style="width:14px;height:14px;border-radius:50%;background:#1a1c2e;border:2px solid ${COLOR_BORDER};box-shadow:0 1px 4px rgba(0,0,0,.25)"></div>`,
        anchor: 'center',
        title: '终点',
      })
      marker.setMap(map)
      overlaysRef.current.push(marker)
    }

    // Per-km markers — small white pills with km number.
    let nextKm = 1
    for (const p of computed) {
      if (p.lng == null || p.lat == null) continue
      while (p.distance_km >= nextKm) {
        const km = nextKm
        const marker = new m.Marker({
          position: [p.lng, p.lat],
          content: `<div style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#ffffff;border:1.5px solid ${COLOR_GREEN};color:#1a1c2e;font-size:10px;font-weight:600;font-family:'JetBrains Mono',monospace;box-shadow:0 1px 3px rgba(0,0,0,.18)">${km}</div>`,
          anchor: 'center',
          title: `${km} km`,
          zIndex: 50,
        })
        marker.setMap(map)
        overlaysRef.current.push(marker)
        nextKm++
      }
    }

    // Fit map to all points.
    if (allCoords.length > 0) {
      const bounds = new m.Bounds(
        [Math.min(...allCoords.map((c) => c[0])), Math.min(...allCoords.map((c) => c[1]))],
        [Math.max(...allCoords.map((c) => c[0])), Math.max(...allCoords.map((c) => c[1]))],
      )
      map.setBounds(bounds, false, [40, 40, 40, 40])
    }

    function openPointPopup(e: any, segPoints: Array<{ idx: number; lng: number; lat: number }>) {
      // Find nearest segPoint to click position.
      const click = e.lnglat
      if (!click) return
      let bestIdx = segPoints[0].idx
      let bestDist = Infinity
      for (const sp of segPoints) {
        const dx = sp.lng - click.getLng()
        const dy = sp.lat - click.getLat()
        const d = dx * dx + dy * dy
        if (d < bestDist) {
          bestDist = d
          bestIdx = sp.idx
        }
      }
      const p = computed[bestIdx]
      const html = `
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.6;padding:4px 6px;color:#1a1c2e;min-width:140px">
          <div style="font-weight:600;margin-bottom:4px">第 ${p.distance_km.toFixed(2)} km</div>
          <div style="color:#666">用时 ${formatTime(p.elapsed)}</div>
          ${p.heart_rate != null ? `<div style="color:#d32f2f">HR ${p.heart_rate} bpm</div>` : ''}
          ${p.speed != null && p.speed > 0 ? `<div style="color:#00a85a">配速 ${paceStr(p.speed)} /km</div>` : ''}
          ${p.altitude != null ? `<div style="color:#0097a7">海拔 ${p.altitude.toFixed(0)} m</div>` : ''}
        </div>`
      const iw = infoWindowRef.current
      if (iw) {
        iw.setContent(html)
        iw.open(map, [p.lng, p.lat])
      }
      onHover?.(p.elapsed)
    }
  }, [AMap, segments, computed, coloring, paceBounds, hrBounds, onHover])

  // 7) Hover marker — driven by external hoverElapsed (HR/Pace chart).
  useEffect(() => {
    const map = mapRef.current
    const m = AMap as any
    if (!map || !m) return
    if (hoverElapsed == null) {
      if (hoverMarkerRef.current) {
        hoverMarkerRef.current.setMap(null)
        hoverMarkerRef.current = null
      }
      return
    }
    // Binary-search the nearest point by elapsed.
    let lo = 0
    let hi = computed.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (computed[mid].elapsed < hoverElapsed) lo = mid + 1
      else hi = mid
    }
    // Walk a few steps if the exact index has no GPS.
    let target = lo
    for (let off = 0; off < 5; off++) {
      const a = lo + off
      const b = lo - off
      if (a < computed.length && computed[a].lng != null) {
        target = a
        break
      }
      if (b >= 0 && computed[b].lng != null) {
        target = b
        break
      }
    }
    const pt = computed[target]
    if (pt.lng == null || pt.lat == null) return

    if (!hoverMarkerRef.current) {
      hoverMarkerRef.current = new m.Marker({
        position: [pt.lng, pt.lat],
        content: `<div style="width:12px;height:12px;border-radius:50%;background:${COLOR_GREEN};border:3px solid ${COLOR_BORDER};box-shadow:0 0 0 1px ${COLOR_GREEN},0 2px 6px rgba(0,0,0,.3)"></div>`,
        anchor: 'center',
        zIndex: 100,
      })
      hoverMarkerRef.current.setMap(map)
    } else {
      hoverMarkerRef.current.setPosition([pt.lng, pt.lat])
    }
  }, [hoverElapsed, computed, AMap])

  // ------------------------ Render ------------------------

  if (error) {
    return (
      <div className="text-text-muted text-sm font-mono py-8 text-center">
        地图加载失败：{error}
      </div>
    )
  }

  if (validGpsCount < 50) {
    return (
      <div className="text-text-muted text-sm font-mono py-8 text-center">无路径数据</div>
    )
  }

  return (
    <div className="relative" style={{ height }}>
      <div ref={mapDiv} className="w-full h-full rounded-xl overflow-hidden" />
      {/* Coloring toggle — top-right segmented control. */}
      <div className="absolute top-3 right-3 inline-flex bg-white/95 border border-border-subtle rounded-lg overflow-hidden shadow-sm font-mono text-[11px]">
        {(['none', 'hr', 'pace'] as Coloring[]).map((c) => (
          <button
            key={c}
            onClick={() => setColoring(c)}
            className={`px-3 py-1.5 transition-colors cursor-pointer ${
              coloring === c
                ? 'bg-accent-green text-white'
                : 'text-text-secondary hover:bg-bg-subtle'
            }`}
          >
            {c === 'none' ? '无色' : c === 'hr' ? 'HR' : '配速'}
          </button>
        ))}
      </div>
    </div>
  )
}
