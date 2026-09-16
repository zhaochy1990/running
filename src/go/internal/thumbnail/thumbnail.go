// Package thumbnail turns an activity's GPS time series into a small route
// thumbnail: a normalized polyline, plus a PNG rendering of that polyline.
//
// The geometry is a port of the Python reference implementation
// (stride_storage/sqlite/database.py: compute_route_thumbnail and its helpers).
// The branch order matches it, but the two have deliberately diverged on two
// points: this port drops invalid samples (see validSample), and it raised the
// compact-route bounding-box cap off the Python value of 600 m (see
// repeatedRouteMaxBBoxM). The Python stack is legacy and being removed; this is
// the production path. Do not "restore parity" on either point without checking
// the tests that pin them.
//
// Everything here is pure: no clock, no I/O, no database.
package thumbnail

import (
	"math"
	"strconv"
	"strings"
)

// Constants mirrored from the Python reference. Do not retune one side only —
// the two implementations must agree or activity thumbnails drift by sport.
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

	repeatedRouteMinPathM = 1200.0
	// repeatedRouteMaxBBoxM caps how large a "compact" loop may be. The Python
	// original used 600 m, which misclassifies real park loops: a 32 km run of
	// ~15 laps around a 615x481 m park sat 2.5% over the cap, fell through to
	// uniform distance sampling, and rendered as a dense scribble (~15x its own
	// bounding-box perimeter) instead of one clean lap. Measured over real
	// traces, repeated loops bound at 1842 m while genuine point-to-point routes
	// start at 7148 m — a 4x gap, so 3000 m sits clear of both.
	repeatedRouteMaxBBoxM         = 3000.0
	repeatedRouteMinBBoxM         = 20.0
	repeatedRoutePathToPerimeter  = 3.0
	repeatedRouteMinAngleCoverage = 0.75
	repeatedRouteMaxCenterDensity = 0.08
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

// Compute builds a downsampled, normalized polyline for an activity thumbnail.
//
// Samples are first filtered, projected into approximate local meters (so the
// aspect ratio survives), then either collapsed into a single loop footprint —
// compact repeated routes such as track laps, which uniform sampling would
// alias into long infield chords — or uniformly downsampled by distance.
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

	projected := projectGPS(valid)
	var sampled []pt
	if isRepeatedCompactRoute(projected) {
		sampled = loopFootprint(projected, TargetPoints)
	} else {
		sampled = downsampleByDistance(projected, TargetPoints)
	}

	return normalize(sampled)
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

// isRepeatedCompactRoute reports whether a track is a small loop traced over and
// over — an oval track, a short crit circuit, a backyard ultra. Such a trace
// covers all directions, stays inside a small bounding box, rarely visits the
// centre, and travels far more than its own perimeter.
func isRepeatedCompactRoute(points []pt) bool {
	minX, maxX, minY, maxY := bounds(points)
	width, height := maxX-minX, maxY-minY
	if width <= 0 || height <= 0 {
		return false
	}
	if math.Max(width, height) > repeatedRouteMaxBBoxM {
		return false
	}
	if math.Min(width, height) < repeatedRouteMinBBoxM {
		return false
	}

	cx, cy := (minX+maxX)/2, (minY+maxY)/2
	const angleBins = 24
	occupied := make(map[int]struct{}, angleBins)
	for _, p := range points {
		occupied[angleBin(p, cx, cy, angleBins)] = struct{}{}
	}
	if float64(len(occupied))/angleBins < repeatedRouteMinAngleCoverage {
		return false
	}

	halfWidth, halfHeight := width/2, height/2
	infield := 0
	for _, p := range points {
		if math.Hypot((p.x-cx)/halfWidth, (p.y-cy)/halfHeight) < 0.6 {
			infield++
		}
	}
	if float64(infield)/float64(len(points)) > repeatedRouteMaxCenterDensity {
		return false
	}

	pathLength := polylineLength(points)
	perimeter := 2 * (width + height)
	return pathLength >= repeatedRouteMinPathM && pathLength/perimeter >= repeatedRoutePathToPerimeter
}

// downsampleByDistance keeps points roughly evenly spaced along the path,
// measured in distance rather than sample count so a long straight gets the
// same visual weight as a dense twisty section.
func downsampleByDistance(points []pt, target int) []pt {
	if len(points) <= target {
		return append([]pt(nil), points...)
	}
	total := polylineLength(points)
	if total <= 0 {
		return append([]pt(nil), points[:target]...)
	}

	interval := total / float64(target-1)
	out := []pt{points[0]}
	nextDistance := interval
	walked := 0.0
	prev := points[0]

	for _, curr := range points[1:] {
		segment := distance(prev, curr)
		for segment > 0 && walked+segment >= nextDistance && len(out) < target-1 {
			ratio := (nextDistance - walked) / segment
			out = append(out, pt{
				x: prev.x + (curr.x-prev.x)*ratio,
				y: prev.y + (curr.y-prev.y)*ratio,
			})
			nextDistance += interval
		}
		walked += segment
		prev = curr
	}

	if last := out[len(out)-1]; last != points[len(points)-1] {
		out = append(out, points[len(points)-1])
	}
	return out
}

// loopFootprint collapses repeated laps into one ordered footprint by averaging
// every visit to each angular sector around the track centroid, then walking the
// sectors out from the start angle. Non-uniform sampling is fine here: a lap is
// not a circle, but each sector still sees the same corner of the same shape.
func loopFootprint(points []pt, target int) []pt {
	var sumX, sumY float64
	for _, p := range points {
		sumX += p.x
		sumY += p.y
	}
	cx, cy := sumX/float64(len(points)), sumY/float64(len(points))

	binCount := max(12, target-1)
	buckets := make([][]pt, binCount)
	for _, p := range points {
		i := angleBin(p, cx, cy, binCount)
		buckets[i] = append(buckets[i], p)
	}

	startIndex := angleBin(points[0], cx, cy, binCount)
	ordered := make([][]pt, 0, binCount)
	ordered = append(ordered, buckets[startIndex:]...)
	ordered = append(ordered, buckets[:startIndex]...)

	footprint := make([]pt, 0, binCount)
	for _, bucket := range ordered {
		if len(bucket) == 0 {
			continue
		}
		var bx, by float64
		for _, p := range bucket {
			bx += p.x
			by += p.y
		}
		footprint = append(footprint, pt{bx / float64(len(bucket)), by / float64(len(bucket))})
	}
	// Too few occupied sectors means this was not really a loop; distrust it.
	if len(footprint) < 12 {
		return downsampleByDistance(points, target)
	}
	// Close the loop so the rendered shape has no visible notch at the start.
	return append(footprint, footprint[0])
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

// angleBin buckets a point into one of bins equal angular sectors around
// (cx, cy), measured counter-clockwise from east.
func angleBin(p pt, cx, cy float64, bins int) int {
	angle := math.Mod(math.Atan2(p.y-cy, p.x-cx)+2*math.Pi, 2*math.Pi)
	return min(int(angle/(2*math.Pi)*float64(bins)), bins-1)
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
