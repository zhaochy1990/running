// Package thumbnail turns an activity's GPS time series into a small route
// thumbnail: a normalized polyline, plus a PNG rendering of that polyline.
//
// The reduction step is NOT the Python reference's. The original thinned by
// distance, which aliases on the routes people actually run — a loop covered
// many times — into a criss-cross tangle, so the Python version bolted on a
// separate "collapse a repeated loop into one footprint" path with its own
// thresholds. That path only ever guessed at which single shape to keep and
// threw away whatever the trace did uniquely (a shortcut taken twice out of
// twenty laps, an inner loop), so it is gone. This port reduces the trace to the
// ground it covers instead — see thinSpatially — which needs no thresholds and
// keeps that structure. Python's stride_storage is legacy and being removed;
// this is the production path.
//
// Everything here is pure: no clock, no I/O, no database.
package thumbnail

import (
	"math"
	"strconv"
	"strings"
)

// Constants inherited from the Python reference.
const (
	// TargetPoints caps the polyline length handed to the renderer and stored
	// in route_thumb_json.
	TargetPoints = 60
	// Viewbox is the square coordinate space the polyline is normalized into.
	// Points land in [0,Viewbox] on both axes, inset by Padding.
	Viewbox = 100
	// Padding keeps the stroke off the canvas edge once the polyline is drawn.
	Padding = 5
	// MinGPSSamples is the cutoff below which a route is not worth drawing at
	// all (indoor, treadmill, GPS-failed activities).
	MinGPSSamples = 10
)

// Sample is one GPS fix from the activity time series. OK=false marks a missing
// fix (a NULL gps_lat/gps_lon row); such rows are skipped rather than treated as
// a position.
type Sample struct {
	Lat float64
	Lon float64
	OK  bool
}

// Point is a normalized thumbnail coordinate in the [0,Viewbox] space, rounded
// to one decimal — the same precision the Python implementation emits.
type Point struct {
	X float64
	Y float64
}

// pt is a working coordinate: either raw (lon, lat) degrees or local meters.
// X is always longitude/east and Y latitude/north.
type pt struct{ x, y float64 }

// Compute builds a thinned, normalized polyline for an activity thumbnail.
//
// Samples are first filtered and projected into approximate local meters (so the
// aspect ratio survives), then reduced to the geometry the route actually covers
// (see thinSpatially).
//
// The result is normalized into [0,Viewbox] with Padding, Y flipped so north is
// up, and rounded to one decimal. ok is false when fewer than MinGPSSamples
// valid fixes are present, in which case the caller should fall back to a sport
// icon.
func Compute(samples []Sample) (points []Point, ok bool) {
	valid := make([]pt, 0, len(samples))
	for _, s := range samples {
		if !validSample(s) {
			continue
		}
		valid = append(valid, pt{s.Lon, s.Lat})
	}
	if len(valid) < MinGPSSamples {
		return nil, false
	}

	return normalize(thinSpatially(projectGPS(valid), TargetPoints))
}

// thinSpatially reduces a trace to the ground it covers, keeping the survivors in
// trace order.
//
// Thinning by distance — keep every n-th metre — is what breaks on a route run
// many times: the interval does not divide the lap evenly, so successive kept
// points land at different places on each lap and the outline criss-crosses into
// a tangle. Keeping a point only when it is far from EVERY point kept so far
// instead collapses repeated laps onto the same line while preserving whatever
// the trace did uniquely — a shortcut taken twice out of twenty-two laps, an
// inner loop, a one-off detour. That is the union of the route's geometry, which
// is what the activity map draws and what a viewer recognises.
//
// The separation is binary-searched so the result fits the budget: the kept count
// falls monotonically as the separation grows, so ~24 probes converge. A grid
// makes the neighbour test O(1); a scan against every kept point would be
// O(points × kept) and this runs over every fix of an activity.
func thinSpatially(points []pt, target int) []pt {
	if len(points) <= target {
		return append([]pt(nil), points...)
	}
	lo, hi := 0.0, polylineLength(points)
	for range 24 {
		mid := (lo + hi) / 2
		if len(keepApart(points, mid)) > target {
			lo = mid
		} else {
			hi = mid
		}
	}
	kept := keepApart(points, hi)
	if len(kept) > target {
		// The search can only land between two separations; a target below what
		// the smallest useful separation yields is not reachable, so trim.
		kept = kept[:target]
	}
	return kept
}

// keepApart keeps a point only when no already-kept point lies within sep of it,
// and splices each run of fresh points back in where it leaves the path already
// kept rather than appending it.
//
// The splice is what keeps the outline honest. Appending fresh runs makes the
// polyline jump from wherever the previous run ended straight to the new one,
// drawing a straight line across the shape that the runner never ran — the
// artefact is plainest for a spur off a loop (a shortcut taken on two laps out of
// twenty), where appending draws a chord from the loop's end to the spur
// instead of joining the spur at its junction.
func keepApart(points []pt, sep float64) []pt {
	if sep <= 0 {
		return append([]pt(nil), points...)
	}
	type cell struct{ x, y int }
	cellOf := func(p pt) cell { return cell{int(math.Floor(p.x / sep)), int(math.Floor(p.y / sep))} }

	// Every covered point, kept or pending, so a repeat of either is skipped.
	grid := make(map[cell][]pt, len(points)/8+1)
	kept := []pt{points[0]}
	grid[cellOf(points[0])] = []pt{points[0]}

	// A point within sep is always inside the 3x3 block of cells around it.
	crowded := func(p pt) bool {
		c := cellOf(p)
		for dx := -1; dx <= 1; dx++ {
			for dy := -1; dy <= 1; dy++ {
				for _, q := range grid[cell{c.x + dx, c.y + dy}] {
					if distance(p, q) < sep {
						return true
					}
				}
			}
		}
		return false
	}

	var pending []pt
	splicePending := func() {
		if len(pending) == 0 {
			return
		}
		// Attach where the spur left the path, not at the end of it.
		at, best := -1, math.Inf(1)
		for i, q := range kept {
			if d := distance(pending[0], q); d < best {
				at, best = i, d
			}
		}
		if at < 0 {
			return
		}
		rest := append([]pt(nil), kept[at+1:]...)
		kept = append(kept[:at+1], pending...)
		kept = append(kept, rest...)
		pending = pending[:0]
	}

	for _, p := range points[1:] {
		if crowded(p) {
			// Back on ground already covered: close any spur we were on.
			splicePending()
			continue
		}
		pending = append(pending, p)
		grid[cellOf(p)] = append(grid[cellOf(p)], p)
	}
	splicePending()
	return kept
}

// JSON renders the polyline as the `[[x,y],...]` string stored in
// activities.route_thumb_json, byte-identical to the Python json.dumps output.
func JSON(points []Point) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, p := range points {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('[')
		b.WriteString(formatCoord(p.X))
		b.WriteByte(',')
		b.WriteString(formatCoord(p.Y))
		b.WriteByte(']')
	}
	b.WriteByte(']')
	return b.String()
}

// validSample drops missing fixes, out-of-range degrees, and the null island
// (0,0) sentinel some watches emit when they have no lock. This matches the
// filter the sync path applies elsewhere.
func validSample(s Sample) bool {
	if !s.OK {
		return false
	}
	if math.IsNaN(s.Lat) || math.IsNaN(s.Lon) {
		return false
	}
	if s.Lat < -90 || s.Lat > 90 || s.Lon < -180 || s.Lon > 180 {
		return false
	}
	return s.Lat != 0 || s.Lon != 0
}

// projectGPS converts (lon, lat) degrees into approximate meters east/north of
// the first fix. Latitude scaling is the standard 111 km/degree; longitude is
// corrected by the mean latitude of the track.
func projectGPS(points []pt) []pt {
	var sumLat float64
	for _, p := range points {
		sumLat += p.y
	}
	meanLatRad := sumLat / float64(len(points)) * math.Pi / 180
	metersPerLon := 111_000 * math.Cos(meanLatRad)
	const metersPerLat = 111_000.0

	origin := points[0]
	out := make([]pt, len(points))
	for i, p := range points {
		out[i] = pt{
			x: (p.x - origin.x) * metersPerLon,
			y: (p.y - origin.y) * metersPerLat,
		}
	}
	return out
}

// normalize fits the polyline into the [Padding, Viewbox-Padding] box, preserving
// aspect ratio, and flips Y so north points up.
func normalize(points []pt) ([]Point, bool) {
	minX, maxX, minY, maxY := bounds(points)
	span := math.Max(maxX-minX, maxY-minY)
	if span <= 0 {
		return nil, false
	}

	scale := float64(Viewbox-2*Padding) / span
	cx, cy := (minX+maxX)/2, (minY+maxY)/2
	half := float64(Viewbox) / 2

	out := make([]Point, len(points))
	for i, p := range points {
		out[i] = Point{
			X: round1((p.x-cx)*scale + half),
			Y: round1(half - (p.y-cy)*scale),
		}
	}
	return out, true
}

func bounds(points []pt) (minX, maxX, minY, maxY float64) {
	minX, maxX = points[0].x, points[0].x
	minY, maxY = points[0].y, points[0].y
	for _, p := range points[1:] {
		minX, maxX = math.Min(minX, p.x), math.Max(maxX, p.x)
		minY, maxY = math.Min(minY, p.y), math.Max(maxY, p.y)
	}
	return minX, maxX, minY, maxY
}

func distance(a, b pt) float64 { return math.Hypot(b.x-a.x, b.y-a.y) }

func polylineLength(points []pt) float64 {
	var total float64
	for i := 1; i < len(points); i++ {
		total += distance(points[i-1], points[i])
	}
	return total
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func formatCoord(v float64) string { return strconv.FormatFloat(v, 'f', 1, 64) }
