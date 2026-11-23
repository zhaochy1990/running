// Route thumbnail, version 2 (devops#1036, epic devops#1034).
//
// The v1 shape is one polyline of at most 60 points. On the routes people
// actually run that loses the three things a list thumbnail exists for: a side
// street does not connect to the loop it leaves from, bends are chorded
// straight, and a long thin out-and-back becomes an unreadable smear at 36 px.
// The confirmed second version (prototypes/route-thumbnail-refinement/refine.py,
// validated locally against 20 real runs) draws the route as an ordered set of
// strokes instead, and this file is its production Go port:
//
//   - the trace is split into parts at >30 s gaps between valid fixes, and a
//     part needs two valid points before it draws anything;
//   - each part is coarsely simplified (tolerance 1 view unit) and walked in
//     time order; an edge that falls entirely inside the 1.3-unit coverage of
//     already-drawn ground is omitted, everything else is kept, so repeated
//     laps draw once and whatever the trace did uniquely survives;
//   - kept spans are re-simplified from the raw points at a 0.32-unit starting
//     tolerance so bends keep their curvature;
//   - a junction where the runner left drawn ground along a road (an omitted
//     leg that matches the drawn stroke's local geometry) shares one exact
//     vertex with that stroke, while real trace endpoints, GPS breaks and
//     merely-nearby parallel roads never get glued on by distance alone;
//   - if the strokes exceed the 60-point budget the tolerance is relaxed by
//     ×1.25 up to 1 and the feasible candidate closest to the trace (two-way
//     Hausdorff over 0.2-densified samples) wins.
//
// Where the prototype leaned on shapely/scipy, the equivalents here are:
// buffer+union+covers → a distance test sampled every 0.2 units along the
// candidate edge plus the kept edges' endpoint projections (distance to the
// kept set is exactly the buffer membership test; sampling bounds the error by
// ±0.1 units, and shapely's own polygonal buffer is itself ~0.011 units inside
// the true disk at quad_segs=6, so both sides sit far below visibility);
// simplify → the Douglas-Peucker port below (returning input indices directly,
// which is how sample provenance is tracked); project/substring/KDTree → the
// arc-length and brute-force helpers below.
//
// Coordinates are quantized to one decimal in the serialized form, exactly like
// the v1 JSON: a shared junction vertex is one float stored in both strokes, so
// quantization cannot separate them. Worst-case displacement vs the unrounded
// prototype output is 0.05 view units — 0.018 px on a 36 px slot, invisible.
//
// Like the rest of the package this is pure: no clock, no I/O, no database.

package thumbnail

import (
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
)

// v2 algorithm constants, in Viewbox units, ported from the prototype.
const (
	// v2GapSeconds is the valid-fix interval above which the trace is split.
	v2GapSeconds = 30
	// v2CoarseTolerance decides which ground is drawn at all.
	v2CoarseTolerance = 1.0
	// v2Coverage is the radius around drawn strokes inside which later edges
	// count as already drawn.
	v2Coverage = 1.3
	// v2CurveError is the starting refinement tolerance for kept spans; the
	// budget search relaxes it by ×1.25 steps up to v2MaxTolerance.
	v2CurveError   = 0.32
	v2MaxTolerance = 1.0
	// Junction-anchor gates: an omitted leg may snap a run endpoint onto a
	// drawn stroke only when the endpoint sits within v2AnchorOffsetGate of a
	// segment AND the leg's probes follow that stroke's local geometry (a
	// v2AnchorEvidenceDepth-unit lookback, v2AnchorEvidenceProbes probes,
	// within v2AnchorCostGate). This is what refuses parallel roads and
	// passers-by.
	v2AnchorOffsetGate      = 1.85
	v2AnchorCostGate        = 1.7
	v2AnchorEvidenceDepth   = 4.0
	v2AnchorEvidenceProbes  = 4
	v2AnchorReplaceDistance = 0.18
	// v2SampleStep densifies polylines for coverage sampling and Hausdorff.
	v2SampleStep = 0.2
	// v2ShapeVersion is the serialization marker distinguishing the v2
	// multi-stroke JSON object from the legacy v1 `[[x,y],...]` array.
	v2ShapeVersion = 2
)

// ShapeV2 is the versioned multi-stroke route shape: strokes the client draws
// as separate paths in time order, the trace's real first and last valid fix
// (which are endpoints of the trace, not of any stroke — an open end must stay
// open), and the three metrics a client needs to compute its own stroke width
// at any display size (see StrokeWidth).
type ShapeV2 struct {
	Strokes [][]Point
	Start   Point
	End     Point
	// Short and Long are the minimum-area rotating rectangle around the whole
	// trace: the short/long side ratio measures how narrow the route is.
	// Short==0 marks a degenerate (straight-line) trace, which never narrows.
	Short float64
	Long  float64
	// Travel is the total length of the simplified trace before dedup — how
	// much ground the runner covered relative to the route's extent.
	Travel float64
}

// TotalPoints counts every stored vertex across all strokes, shared junction
// vertices included once per stroke that stores them — the same accounting the
// 60-point budget uses.
func (s *ShapeV2) TotalPoints() int {
	n := 0
	for _, stroke := range s.Strokes {
		n += len(stroke)
	}
	return n
}

// ComputeV2 builds the v2 multi-stroke shape for an activity thumbnail. ok is
// false when there is nothing worth drawing (fewer than MinGPSSamples valid
// fixes, a zero-extent trace, or no part with two valid fixes) and the caller
// should fall back to a sport icon, exactly like Compute.
func ComputeV2(samples []Sample) (*ShapeV2, bool) {
	type fix struct {
		p  pt
		ts int64
	}
	valid := make([]fix, 0, len(samples))
	for _, s := range samples {
		if !validSample(s) {
			continue
		}
		valid = append(valid, fix{pt{s.Lon, s.Lat}, s.Ts})
	}
	if len(valid) < MinGPSSamples {
		return nil, false
	}

	meters := make([]pt, len(valid))
	for i, f := range valid {
		meters[i] = f.p
	}
	meters = projectGPS(meters)

	// Split into parts at >30 s gaps. A missing timestamp (0) never splits:
	// an unknown interval is not a long interval.
	parts := [][]pt{{meters[0]}}
	for i := 1; i < len(meters); i++ {
		prev, cur := valid[i-1].ts, valid[i].ts
		if prev != 0 && cur != 0 && cur-prev > v2GapSeconds {
			parts = append(parts, nil)
		}
		parts[len(parts)-1] = append(parts[len(parts)-1], meters[i])
	}

	all := make([]pt, 0, len(meters))
	for _, part := range parts {
		all = append(all, part...)
	}
	minX, maxX, minY, maxY := bounds(all)
	span := math.Max(maxX-minX, maxY-minY)
	if span <= 0 {
		return nil, false
	}
	scale := float64(Viewbox-2*Padding) / span
	cx, cy := (minX+maxX)/2, (minY+maxY)/2
	half := float64(Viewbox) / 2
	view := func(p pt) pt { return pt{(p.x-cx)*scale + half, half - (p.y-cy)*scale} }

	viewParts := make([][]pt, len(parts))
	for i, part := range parts {
		viewParts[i] = make([]pt, len(part))
		for j, p := range part {
			viewParts[i][j] = view(p)
		}
	}

	runs, travel := v2VisibleRuns(viewParts)
	if len(runs) == 0 {
		return nil, false
	}
	strokes := v2Refine(viewParts, runs)

	viewAll := make([]pt, len(all))
	for i, p := range all {
		viewAll[i] = view(p)
	}
	short, long := v2RouteSides(viewAll)

	shape := &ShapeV2{Short: short, Long: long, Travel: travel}
	shape.Strokes = make([][]Point, len(strokes))
	for i, stroke := range strokes {
		shape.Strokes[i] = make([]Point, len(stroke))
		for j, p := range stroke {
			shape.Strokes[i][j] = Point{X: p.x, Y: p.y}
		}
	}
	startV, endV := view(meters[0]), view(meters[len(meters)-1])
	shape.Start = Point{X: startV.x, Y: startV.y}
	shape.End = Point{X: endV.x, Y: endV.y}
	return shape, true
}

// v2Run is one kept span of one part: the raw part (view coordinates), the
// inclusive index range [first,last] that is drawn, and — when the span begins
// or ends against an omitted leg — the index of the coarse vertex on the far
// side of that leg (enter before first, leave after last), or -1.
type v2Run struct {
	part         []pt
	first, last  int
	enter, leave int
}

// v2VisibleRuns ports the prototype's visible_runs: coarsely simplify each
// part, keep the edges that leave the coverage of what is already drawn, group
// consecutive kept edges into runs, and return the pre-dedup travel too.
func v2VisibleRuns(parts [][]pt) (runs []v2Run, travel float64) {
	var covered []v2Seg
	for _, part := range parts {
		if len(part) < 2 {
			continue
		}
		idx := v2SimplifyIndices(part, v2CoarseTolerance)
		visible := make([]bool, len(idx)-1)
		for i := 0; i+1 < len(idx); i++ {
			e := v2Seg{part[idx[i]], part[idx[i+1]]}
			travel += e.length()
			keep := e.length() > 0 && (len(covered) == 0 || !v2CoveredBy(covered, e))
			visible[i] = keep
			if keep {
				covered = append(covered, e)
			}
		}
		start := 0
		for start < len(visible) {
			if !visible[start] {
				start++
				continue
			}
			end := start + 1
			for end < len(visible) && visible[end] {
				end++
			}
			r := v2Run{part: part, first: idx[start], last: idx[end], enter: -1, leave: -1}
			if start > 0 {
				r.enter = idx[start-1]
			}
			if end < len(visible) {
				r.leave = idx[end+1]
			}
			runs = append(runs, r)
			start = end
		}
	}
	return runs, travel
}

// v2DrawRuns ports draw_runs: refine one run from its raw points at the given
// tolerance, then try to anchor both ends against the strokes drawn so far.
func v2DrawRuns(runs []v2Run, tolerance float64) [][]pt {
	var strokes [][]pt
	for _, r := range runs {
		span := r.part[r.first : r.last+1]
		idx := v2SimplifyIndices(span, tolerance)
		pts := make([]pt, len(idx))
		for i, ix := range idx {
			pts[i] = span[ix]
		}
		if r.enter >= 0 {
			evidence := make([]pt, 0, r.first+1-r.enter)
			for i := r.first; i >= r.enter; i-- {
				evidence = append(evidence, r.part[i])
			}
			if anchor, ok := v2SupportAnchor(&strokes, pts[0], evidence); ok {
				if distance(anchor, pts[0]) > v2AnchorReplaceDistance {
					pts = append([]pt{anchor}, pts...)
				} else {
					pts[0] = anchor
				}
			}
		}
		if r.leave >= 0 {
			evidence := r.part[r.last : r.leave+1]
			last := len(pts) - 1
			if anchor, ok := v2SupportAnchor(&strokes, pts[last], evidence); ok {
				if distance(anchor, pts[last]) > v2AnchorReplaceDistance {
					pts = append(pts, anchor)
				} else {
					pts[last] = anchor
				}
			}
		}
		strokes = append(strokes, pts)
	}
	return strokes
}

// v2SupportAnchor ports support_anchor: project endpoint onto the best supporting
// segment of an already-drawn stroke — near enough, and corroborated by the
// omitted leg following that stroke locally — and share one exact vertex by
// inserting the projection into the stroke. A parallel arm whose neighbourhood
// the runner never travelled is refused by the local-window cost.
func v2SupportAnchor(strokes *[][]pt, endpoint pt, evidence []pt) (pt, bool) {
	if len(evidence) < 2 || len(*strokes) == 0 {
		return pt{}, false
	}
	depth := math.Min(v2AnchorEvidenceDepth, polylineLength(evidence))
	if depth < 1.0 {
		return pt{}, false
	}
	probes := make([]pt, v2AnchorEvidenceProbes)
	for i := range probes {
		probes[i] = v2PointAtArc(evidence, depth*float64(i+1)/float64(v2AnchorEvidenceProbes))
	}

	best := math.Inf(1)
	bi, bj := -1, -1
	var bpos pt
	for i := range *strokes {
		stroke := (*strokes)[i]
		for j := 0; j+1 < len(stroke); j++ {
			a, b := stroke[j], stroke[j+1]
			length := distance(a, b)
			if length == 0 {
				continue
			}
			pos, t := v2ProjectOnSeg(endpoint, a, b)
			offset := distance(pos, endpoint)
			if offset > v2AnchorOffsetGate {
				continue
			}
			if v2MaxPolyDistance(probes, stroke) > v2AnchorCostGate {
				continue
			}
			along := polylineLength(stroke[:j+1]) + t*length
			total := polylineLength(stroke)
			lo := math.Max(0, along-depth-2)
			hi := math.Min(total, along+depth+2)
			cost := v2MaxPolyDistance(probes, v2Substring(stroke, lo, hi))
			if cost > v2AnchorCostGate {
				continue
			}
			if score := offset + cost; score < best {
				best, bi, bj, bpos = score, i, j, pos
			}
		}
	}
	if bi < 0 {
		return pt{}, false
	}
	stroke := (*strokes)[bi]
	for _, q := range stroke[bj : bj+2] {
		if distance(q, bpos) < 1e-8 {
			return q, true
		}
	}
	(*strokes)[bi] = append(stroke[:bj+1], append([]pt{bpos}, stroke[bj+1:]...)...)
	return bpos, true
}

// v2Refine ports refine and adds the deterministic degradation the prototype
// lacked (it raised ValueError): if no tolerance up to the cap fits the budget,
// the shortest run is dropped — an anomalous fragment goes first — and the
// search restarts from the base tolerance; a lone run that still does not fit
// gets its tolerance relaxed past the cap until it does. Both paths terminate:
// dropping reaches one run, and simplification is monotone in tolerance.
func v2Refine(parts [][]pt, runs []v2Run) [][]pt {
	for {
		strokes := v2DrawRuns(runs, v2CurveError)
		if v2TotalPoints(strokes) <= TargetPoints {
			return strokes
		}
		reference := v2SamplesAlong(parts, v2SampleStep)
		var best [][]pt
		bestErr := math.Inf(1)
		tolerance := v2CurveError
		for tolerance < v2MaxTolerance {
			tolerance = math.Min(v2MaxTolerance, tolerance*1.25)
			candidate := v2DrawRuns(runs, tolerance)
			if v2TotalPoints(candidate) > TargetPoints {
				continue
			}
			if err := v2Hausdorff(reference, v2SamplesAlong(candidate, v2SampleStep)); err < bestErr {
				bestErr, best = err, candidate
			}
		}
		if best != nil {
			return best
		}
		if len(runs) > 1 {
			runs = v2DropShortestRun(runs)
			continue
		}
		tolerance = v2MaxTolerance
		for tolerance < 1e6 {
			tolerance *= 1.25
			candidate := v2DrawRuns(runs, tolerance)
			if v2TotalPoints(candidate) <= TargetPoints {
				return candidate
			}
		}
		// Unreachable: a single run collapses to two points as the tolerance
		// grows. Trim rather than loop forever, whatever the input.
		return v2TrimToBudget(v2DrawRuns(runs, 1e6))
	}
}

// v2DropShortestRun removes the run covering the least raw ground; ties break
// to the earliest run so the degradation is deterministic.
func v2DropShortestRun(runs []v2Run) []v2Run {
	worst := 0
	worstLen := math.Inf(1)
	for i, r := range runs {
		if l := polylineLength(r.part[r.first : r.last+1]); l < worstLen {
			worstLen, worst = l, i
		}
	}
	return append(runs[:worst:worst], runs[worst+1:]...)
}

// v2TrimToBudget is the last-resort degradation: drop whole strokes from the
// end until the budget holds.
func v2TrimToBudget(strokes [][]pt) [][]pt {
	for v2TotalPoints(strokes) > TargetPoints && len(strokes) > 1 {
		strokes = strokes[:len(strokes)-1]
	}
	return strokes
}

func v2TotalPoints(strokes [][]pt) int {
	n := 0
	for _, s := range strokes {
		n += len(s)
	}
	return n
}

// v2SimplifyIndices is Douglas-Peucker at the given tolerance, returning the
// kept vertices as indices into pts. Endpoints are always kept; a vertex
// survives only when it sits more than tolerance from the current chord.
// Indices (rather than coordinates) are the point: the caller needs to know
// which raw samples a simplified vertex came from.
func v2SimplifyIndices(pts []pt, tolerance float64) []int {
	if len(pts) <= 2 {
		idx := make([]int, len(pts))
		for i := range idx {
			idx[i] = i
		}
		return idx
	}
	keep := make([]bool, len(pts))
	keep[0], keep[len(pts)-1] = true, true
	type span struct{ lo, hi int }
	stack := []span{{0, len(pts) - 1}}
	for len(stack) > 0 {
		s := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if s.hi <= s.lo+1 {
			continue
		}
		var maxD float64
		farthest := -1
		for k := s.lo + 1; k < s.hi; k++ {
			if d := v2PointSegDistance(pts[k], pts[s.lo], pts[s.hi]); d > maxD {
				maxD, farthest = d, k
			}
		}
		if maxD > tolerance {
			keep[farthest] = true
			stack = append(stack, span{s.lo, farthest}, span{farthest, s.hi})
		}
	}
	idx := make([]int, 0, len(pts))
	for i, k := range keep {
		if k {
			idx = append(idx, i)
		}
	}
	return idx
}

// v2Seg is a drawn segment in view coordinates.
type v2Seg struct{ a, b pt }

func (s v2Seg) length() float64 { return distance(s.a, s.b) }

// v2CoveredBy reports whether every point of e lies within v2Coverage of the
// kept segments — the prototype's buffered-union covers() test, evaluated by
// sampling: the endpoints, a 0.2-unit grid, and the kept endpoints projected
// onto e (the only places the nearest kept feature can change), each tested
// against every kept segment. The grid bounds the error at ±0.1 units, well
// under any threshold this result feeds.
func v2CoveredBy(kept []v2Seg, e v2Seg) bool {
	l := e.length()
	n := int(math.Ceil(l / v2SampleStep))
	if n < 1 {
		n = 1
	}
	tests := make([]pt, 0, n+1+2*len(kept))
	tests = append(tests, e.a, e.b)
	for i := 1; i < n; i++ {
		t := float64(i) / float64(n)
		tests = append(tests, pt{e.a.x + (e.b.x-e.a.x)*t, e.a.y + (e.b.y-e.a.y)*t})
	}
	for _, k := range kept {
		projA, _ := v2ProjectOnSeg(k.a, e.a, e.b)
		projB, _ := v2ProjectOnSeg(k.b, e.a, e.b)
		tests = append(tests, projA, projB)
	}
	for _, p := range tests {
		dmin := math.Inf(1)
		for _, k := range kept {
			if d := v2PointSegDistance(p, k.a, k.b); d < dmin {
				dmin = d
			}
		}
		if dmin > v2Coverage {
			return false
		}
	}
	return true
}

// v2PointSegDistance is the distance from p to the segment ab.
func v2PointSegDistance(p, a, b pt) float64 {
	pos, _ := v2ProjectOnSeg(p, a, b)
	return distance(p, pos)
}

// v2ProjectOnSeg projects p onto segment ab; t is the clamped position along
// the segment.
func v2ProjectOnSeg(p, a, b pt) (pt, float64) {
	dx, dy := b.x-a.x, b.y-a.y
	if dx == 0 && dy == 0 {
		return a, 0
	}
	t := ((p.x-a.x)*dx + (p.y-a.y)*dy) / (dx*dx + dy*dy)
	t = math.Max(0, math.Min(1, t))
	return pt{a.x + t*dx, a.y + t*dy}, t
}

// v2PointAtArc returns the point at arc distance d along the polyline.
func v2PointAtArc(pts []pt, d float64) pt {
	if d <= 0 {
		return pts[0]
	}
	for i := 1; i < len(pts); i++ {
		l := distance(pts[i-1], pts[i])
		if l == 0 {
			continue
		}
		if d <= l {
			t := d / l
			return pt{pts[i-1].x + (pts[i].x-pts[i-1].x)*t, pts[i-1].y + (pts[i].y-pts[i-1].y)*t}
		}
		d -= l
	}
	return pts[len(pts)-1]
}

// v2Substring returns the sub-polyline between arc distances [lo,hi], with
// interpolated ends; a zero-width window degenerates to one point.
func v2Substring(pts []pt, lo, hi float64) []pt {
	if hi <= lo {
		return []pt{v2PointAtArc(pts, lo)}
	}
	out := []pt{v2PointAtArc(pts, lo)}
	arc := 0.0
	for i := 1; i < len(pts); i++ {
		l := distance(pts[i-1], pts[i])
		segStart, segEnd := arc, arc+l
		if segEnd > lo && l > 0 {
			if segEnd <= hi {
				out = append(out, pts[i])
			} else if segStart < hi {
				t := (hi - segStart) / l
				out = append(out, pt{pts[i-1].x + (pts[i].x-pts[i-1].x)*t, pts[i-1].y + (pts[i].y-pts[i-1].y)*t})
			}
		}
		arc = segEnd
	}
	return out
}

// v2MaxPolyDistance is the largest distance from any probe to the polyline.
func v2MaxPolyDistance(probes, pts []pt) float64 {
	dminToPoly := func(p pt) float64 {
		if len(pts) == 1 {
			return distance(p, pts[0])
		}
		dmin := math.Inf(1)
		for i := 1; i < len(pts); i++ {
			if d := v2PointSegDistance(p, pts[i-1], pts[i]); d < dmin {
				dmin = d
			}
		}
		return dmin
	}
	worst := 0.0
	for _, p := range probes {
		if d := dminToPoly(p); d > worst {
			worst = d
		}
	}
	return worst
}

// v2SamplesAlong densifies polylines at roughly step spacing, endpoints
// included — the sample set the Hausdorff comparison runs over.
func v2SamplesAlong(lines [][]pt, step float64) []pt {
	var out []pt
	for _, pts := range lines {
		if len(pts) == 0 {
			continue
		}
		out = append(out, pts[0])
		for i := 1; i < len(pts); i++ {
			l := distance(pts[i-1], pts[i])
			steps := int(math.Ceil(l / step))
			if steps < 1 {
				steps = 1
			}
			for k := 1; k <= steps; k++ {
				t := float64(k) / float64(steps)
				out = append(out, pt{pts[i-1].x + (pts[i].x-pts[i-1].x)*t, pts[i-1].y + (pts[i].y-pts[i-1].y)*t})
			}
		}
	}
	return out
}

// v2Hausdorff is the two-sided maximum nearest-neighbour distance between two
// point sets — the prototype's paired KDTree queries, brute-forced. Sets here
// are at most a few thousand points, once per activity.
func v2Hausdorff(a, b []pt) float64 {
	nn := func(p pt, set []pt) float64 {
		dmin := math.Inf(1)
		for _, q := range set {
			if d := distance(p, q); d < dmin {
				dmin = d
			}
		}
		return dmin
	}
	worst := 0.0
	for _, p := range a {
		if d := nn(p, b); d > worst {
			worst = d
		}
	}
	for _, p := range b {
		if d := nn(p, a); d > worst {
			worst = d
		}
	}
	return worst
}

// v2RouteSides returns the short and long side of the minimum-area rectangle
// over the trace (rotating-calipers style, one candidate orientation per hull
// edge). A degenerate hull (collinear trace) reports Short==0.
func v2RouteSides(points []pt) (short, long float64) {
	hull := v2ConvexHull(points)
	if len(hull) < 3 || v2ShoelaceArea(hull) < 1e-12 {
		return 0, polylineLength(hull)
	}
	best := math.Inf(1)
	n := len(hull)
	for i := 0; i < n; i++ {
		a, b := hull[i], hull[(i+1)%n]
		l := distance(a, b)
		if l == 0 {
			continue
		}
		ux, uy := (b.x-a.x)/l, (b.y-a.y)/l
		nx, ny := -uy, ux
		minU, maxU := math.Inf(1), math.Inf(-1)
		minN, maxN := math.Inf(1), math.Inf(-1)
		for _, v := range hull {
			u := v.x*ux + v.y*uy
			w := v.x*nx + v.y*ny
			minU, maxU = math.Min(minU, u), math.Max(maxU, u)
			minN, maxN = math.Min(minN, w), math.Max(maxN, w)
		}
		spanU, spanN := maxU-minU, maxN-minN
		if area := spanU * spanN; area < best {
			best = area
			short, long = math.Min(spanU, spanN), math.Max(spanU, spanN)
		}
	}
	return short, long
}

// v2ConvexHull is Andrew's monotone chain; collinear points on the hull are
// dropped, so a collinear trace collapses to its two extremes.
func v2ConvexHull(points []pt) []pt {
	pts := append([]pt(nil), points...)
	sort.Slice(pts, func(i, j int) bool {
		if pts[i].x != pts[j].x {
			return pts[i].x < pts[j].x
		}
		return pts[i].y < pts[j].y
	})
	uniq := pts[:0]
	for i, p := range pts {
		if i == 0 || p != pts[i-1] {
			uniq = append(uniq, p)
		}
	}
	pts = uniq
	if len(pts) < 2 {
		return pts
	}
	cross := func(o, a, b pt) float64 { return (a.x-o.x)*(b.y-o.y) - (a.y-o.y)*(b.x-o.x) }
	hull := make([]pt, 0, 2*len(pts))
	for _, p := range pts {
		for len(hull) >= 2 && cross(hull[len(hull)-2], hull[len(hull)-1], p) <= 0 {
			hull = hull[:len(hull)-1]
		}
		hull = append(hull, p)
	}
	lower := len(hull) + 1
	for i := len(pts) - 2; i >= 0; i-- {
		p := pts[i]
		for len(hull) >= lower && cross(hull[len(hull)-2], hull[len(hull)-1], p) <= 0 {
			hull = hull[:len(hull)-1]
		}
		hull = append(hull, p)
	}
	return hull[:len(hull)-1]
}

func v2ShoelaceArea(hull []pt) float64 {
	area := 0.0
	n := len(hull)
	for i := range hull {
		a, b := hull[i], hull[(i+1)%n]
		area += a.x*b.y - b.x*a.y
	}
	return math.Abs(area) / 2
}

// EncodeV2 renders the shape as the versioned JSON object the activity list
// ships to new clients, coordinates and metrics at one decimal like the v1
// format. The leading "v" field is what makes it distinguishable from the
// legacy `[[x,y],...]` array, which stays readable for old clients.
func EncodeV2(s *ShapeV2) string {
	var b strings.Builder
	b.WriteString(`{"v":2,"strokes":[`)
	for i, stroke := range s.Strokes {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('[')
		for j, p := range stroke {
			if j > 0 {
				b.WriteByte(',')
			}
			b.WriteByte('[')
			b.WriteString(formatCoord(p.X))
			b.WriteByte(',')
			b.WriteString(formatCoord(p.Y))
			b.WriteByte(']')
		}
		b.WriteByte(']')
	}
	b.WriteString(`],"start":[`)
	b.WriteString(formatCoord(s.Start.X))
	b.WriteByte(',')
	b.WriteString(formatCoord(s.Start.Y))
	b.WriteString(`],"end":[`)
	b.WriteString(formatCoord(s.End.X))
	b.WriteByte(',')
	b.WriteString(formatCoord(s.End.Y))
	b.WriteString(`],"short":`)
	b.WriteString(strconv.FormatFloat(s.Short, 'f', 1, 64))
	b.WriteString(`,"long":`)
	b.WriteString(strconv.FormatFloat(s.Long, 'f', 1, 64))
	b.WriteString(`,"travel":`)
	b.WriteString(strconv.FormatFloat(s.Travel, 'f', 1, 64))
	b.WriteByte('}')
	return b.String()
}

// shapeV2JSON mirrors EncodeV2's wire format for decoding.
type shapeV2JSON struct {
	V       int            `json:"v"`
	Strokes [][][2]float64 `json:"strokes"`
	Start   [2]float64     `json:"start"`
	End     [2]float64     `json:"end"`
	Short   float64        `json:"short"`
	Long    float64        `json:"long"`
	Travel  float64        `json:"travel"`
}

// DecodeV2 parses and validates the v2 shape JSON. A legacy v1 array, a
// different version marker, or a shape that violates the format's invariants
// (empty strokes, sub-2-point strokes, coordinates outside the viewbox,
// negative metrics) is an error rather than a best-effort shape.
func DecodeV2(s string) (*ShapeV2, error) {
	var raw shapeV2JSON
	if err := json.Unmarshal([]byte(s), &raw); err != nil {
		return nil, err
	}
	if raw.V != v2ShapeVersion {
		return nil, errors.New("route shape: version must be 2")
	}
	if len(raw.Strokes) == 0 {
		return nil, errors.New("route shape: no strokes")
	}
	inView := func(c [2]float64) bool {
		return c[0] >= -0.05 && c[0] <= float64(Viewbox)+0.05 && c[1] >= -0.05 && c[1] <= float64(Viewbox)+0.05
	}
	shape := &ShapeV2{
		Start:  Point{X: raw.Start[0], Y: raw.Start[1]},
		End:    Point{X: raw.End[0], Y: raw.End[1]},
		Short:  raw.Short,
		Long:   raw.Long,
		Travel: raw.Travel,
	}
	shape.Strokes = make([][]Point, len(raw.Strokes))
	for i, stroke := range raw.Strokes {
		if len(stroke) < 2 {
			return nil, errors.New("route shape: stroke with fewer than two points")
		}
		shape.Strokes[i] = make([]Point, len(stroke))
		for j, c := range stroke {
			if !inView(c) {
				return nil, errors.New("route shape: coordinate outside the viewbox")
			}
			shape.Strokes[i][j] = Point{X: c[0], Y: c[1]}
		}
	}
	if !inView(raw.Start) || !inView(raw.End) {
		return nil, errors.New("route shape: endpoint outside the viewbox")
	}
	if raw.Short < 0 || raw.Long < 0 || raw.Travel < 0 || raw.Short > raw.Long {
		return nil, errors.New("route shape: bad width metrics")
	}
	return shape, nil
}

// StrokeWidth computes the logical stroke width for a shape at a given logical
// display size, ported from the prototype's small_width: only narrow,
// repeatedly-travelled routes thin down at small sizes, and large displays
// always return to the regular width. Width metrics come from the shape
// (Short==0 — a straight-line trace — never narrows).
func StrokeWidth(displaySize, short, long, travel float64) float64 {
	base := displaySize / 30
	if short <= 0 || long <= 0 {
		return base
	}
	narrow := clamp01((0.23 - short/long) / 0.10)
	repeat := clamp01((travel/long - 1.5) / 0.5)
	weight := clamp01((56-displaySize)/20) * narrow * repeat
	return base * (1 - 0.25*weight)
}

func clamp01(v float64) float64 { return math.Max(0, math.Min(1, v)) }
