package thumbnail

// Version-2 route shape tests (devops#1036, epic devops#1034). All traces are
// synthetic: real user data is only ever replayed in controlled environments,
// never committed. Traces are laid out in "design meters" chosen so the trace
// spans exactly Viewbox-2*Padding=90 units on its long axis — corners carry no
// wobble, so the normalization is the exact affine map x'=x+5, y'=80-y (for a
// y range of [0,60]) and design-space distances equal view-space ones.

import (
	"math"
	"strings"
	"testing"
)

// v2Trace densifies a continuous route given as legs of design-space corners
// into Samples with 1 s spacing. Corners are emitted exactly; interior points
// carry a small deterministic perpendicular wobble, like a real GPS trace.
func v2Trace(tsBase int64, legs ...[][2]float64) []Sample {
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))

	var corners [][2]float64
	for _, leg := range legs {
		for _, c := range leg {
			if len(corners) > 0 && c == corners[len(corners)-1] {
				continue
			}
			corners = append(corners, c)
		}
	}

	const step = 3.0
	const wobble = 0.12
	var samples []Sample
	ts, n := tsBase, 0
	samples = append(samples, Sample{
		Lat: trackLat0 + corners[0][1]*latPerMeter,
		Lon: trackLon0 + corners[0][0]*lonPerMeter,
		OK:  true,
		Ts:  ts,
	})
	ts++
	n++
	for i := 0; i+1 < len(corners); i++ {
		a, b := corners[i], corners[i+1]
		l := math.Hypot(b[0]-a[0], b[1]-a[1])
		ux, uy := (b[0]-a[0])/l, (b[1]-a[1])/l
		count := int(math.Ceil(l / step))
		for k := 1; k < count; k++ {
			t := float64(k) / float64(count)
			w := wobble * math.Sin(float64(n)*2.399) * math.Sin(math.Pi*t)
			x := a[0] + (b[0]-a[0])*t - uy*w
			y := a[1] + (b[1]-a[1])*t + ux*w
			samples = append(samples, Sample{
				Lat: trackLat0 + y*latPerMeter,
				Lon: trackLon0 + x*lonPerMeter,
				OK:  true,
				Ts:  ts,
			})
			ts++
			n++
		}
		end := corners[i+1]
		samples = append(samples, Sample{
			Lat: trackLat0 + end[1]*latPerMeter,
			Lon: trackLon0 + end[0]*lonPerMeter,
			OK:  true,
			Ts:  ts,
		})
		ts++
		n++
	}
	return samples
}

// v2RoundTrip encodes and decodes a shape, failing the test if either
// direction does not round-trip cleanly.
func v2RoundTrip(t *testing.T, shape *ShapeV2) *ShapeV2 {
	t.Helper()
	encoded := EncodeV2(shape)
	decoded, err := DecodeV2(encoded)
	if err != nil {
		t.Fatalf("DecodeV2(EncodeV2(shape)) failed: %v", err)
	}
	if reencoded := EncodeV2(decoded); reencoded != encoded {
		t.Fatalf("encode(decode(encode(shape))) is not stable:\n%s\n%s", encoded, reencoded)
	}
	return decoded
}

func v2StrokeLength(points []Point) float64 {
	total := 0.0
	for i := 1; i < len(points); i++ {
		total += math.Hypot(points[i].X-points[i-1].X, points[i].Y-points[i-1].Y)
	}
	return total
}

// v2DistanceToStroke is the distance from p to the nearest point of a drawn
// stroke, in view units.
func v2DistanceToStroke(p Point, stroke []Point) float64 {
	best := math.Inf(1)
	for i := 1; i < len(stroke); i++ {
		a := pt{stroke[i-1].X, stroke[i-1].Y}
		b := pt{stroke[i].X, stroke[i].Y}
		if d := v2PointSegDistance(pt{p.X, p.Y}, a, b); d < best {
			best = d
		}
	}
	return best
}

// v2SharedVertex reports whether p is exactly one of the stroke's vertices.
// Junction sharing must survive quantization as exact equality: the same float
// is stored in both strokes, so the encoded decimals — and the decoded
// values — must match to the last bit.
func v2SharedVertex(p Point, stroke []Point) bool {
	for _, q := range stroke {
		if p == q {
			return true
		}
	}
	return false
}

func v2CheckShapeInvariants(t *testing.T, shape *ShapeV2, context string) {
	t.Helper()
	if shape.TotalPoints() > TargetPoints {
		t.Fatalf("%s: %d points exceeds the %d-point budget", context, shape.TotalPoints(), TargetPoints)
	}
	for si, stroke := range shape.Strokes {
		if len(stroke) < 2 {
			t.Fatalf("%s: stroke %d has %d points", context, si, len(stroke))
		}
		withinViewport(t, stroke)
	}
}

// A junction the runner really travelled along — leave the drawn loop along a
// covered leg, cut across, rejoin the drawn loop, leave again along a covered
// leg — must share one exact vertex per end between the side street and the
// outer stroke, through serialization (epic "路口与断笔": 横街两端 8/8 共点).
func TestComputeV2JunctionSharesExactVertices(t *testing.T) {
	shape, ok := ComputeV2(v2Trace(1000,
		[][2]float64{{0, 0}, {90, 0}, {90, 60}, {0, 60}, {0, 0}}, // outer loop, drawn
		[][2]float64{{0, 0}, {45, 0}},                            // re-run covered bottom, omitted
		[][2]float64{{45, 0}, {45, 60}},                          // side street across, drawn
		[][2]float64{{45, 60}, {0, 60}},                          // re-run covered top, omitted
		[][2]float64{{0, 60}, {0, 0}},                            // re-run covered left, omitted
	))
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, shape, "junction")

	decoded := v2RoundTrip(t, shape)
	if len(decoded.Strokes) != 2 {
		t.Fatalf("want 2 strokes (outer + side street), got %d", len(decoded.Strokes))
	}
	outer, side := decoded.Strokes[0], decoded.Strokes[1]
	if got := v2StrokeLength(outer); got < 290 {
		t.Fatalf("outer stroke length %.1f — the loop did not survive", got)
	}
	for _, end := range []Point{side[0], side[len(side)-1]} {
		if !v2SharedVertex(end, outer) {
			t.Fatalf("side street endpoint %+v is not an exact outer-stroke vertex; outer=%v", end, outer)
		}
	}
}

// A side street that is an out-and-back entered along covered ground keeps its
// real turnaround: only the entry end shares a vertex; the far end is a real
// trace endpoint (epic: 11/03 19:15 横街末端保留真实终点).
func TestComputeV2SideStreetKeepsRealTurnaround(t *testing.T) {
	shape, ok := ComputeV2(v2Trace(1000,
		[][2]float64{{0, 0}, {90, 0}, {90, 60}, {0, 60}, {0, 0}},
		[][2]float64{{0, 0}, {45, 0}},
		[][2]float64{{45, 0}, {45, 32}},
		[][2]float64{{45, 32}, {45, 0}},
		[][2]float64{{45, 0}, {0, 0}},
	))
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, shape, "turnaround")
	decoded := v2RoundTrip(t, shape)

	var side []Point
	for _, stroke := range decoded.Strokes {
		if v2SharedVertex(stroke[0], decoded.Strokes[0]) && len(stroke) < len(decoded.Strokes[0]) {
			side = stroke
		}
	}
	if side == nil {
		t.Fatalf("no side-street stroke found: %v", decoded.Strokes)
	}
	if !v2SharedVertex(side[0], decoded.Strokes[0]) {
		t.Fatalf("side street entry %+v is not shared with the outer stroke", side[0])
	}
	turnaround := side[len(side)-1]
	if v2SharedVertex(turnaround, decoded.Strokes[0]) {
		t.Fatalf("turnaround %+v was snapped onto the outer stroke", turnaround)
	}
	// The turnaround is 32 design units below the top edge (28 view units from
	// it) and 32 above the bottom edge: near nothing drawn, and undrifted.
	got := v2DistanceToStroke(turnaround, decoded.Strokes[0])
	if got < 5 || got > 34 {
		t.Fatalf("turnaround %+v sits %.2f from the outer stroke — snapped or drifted", turnaround, got)
	}
}

// A >30 s gap between valid fixes splits the trace into parts that never
// connect: two spatially separate areas draw as two strokes, exactly 30 s does
// not split, and a lone fix between gaps draws nothing.
func TestComputeV2SplitsAtGPSGap(t *testing.T) {
	areaA := [][2]float64{{0, 0}, {30, 0}, {30, 30}, {0, 30}, {0, 0}}
	areaB := [][2]float64{{60, 0}, {90, 0}, {90, 30}, {60, 30}, {60, 0}}

	// 31 s apart (and 45 s): two parts, two strokes, nothing bridging them.
	for _, gap := range []int64{31, 45} {
		traceA := v2Trace(0, areaA)
		traceB := v2Trace(traceA[len(traceA)-1].Ts+gap, areaB)
		shape, ok := ComputeV2(append(traceA, traceB...))
		if !ok {
			t.Fatalf("gap %d s: ComputeV2 returned no shape", gap)
		}
		v2CheckShapeInvariants(t, shape, "gap")
		decoded := v2RoundTrip(t, shape)
		if len(decoded.Strokes) != 2 {
			t.Fatalf("gap %d s: want 2 strokes, got %d", gap, len(decoded.Strokes))
		}
		for _, p := range decoded.Strokes[0] {
			if p.X > 48 {
				t.Fatalf("gap %d s: left-area stroke reaches x=%.1f", gap, p.X)
			}
		}
		for _, p := range decoded.Strokes[1] {
			if p.X < 52 {
				t.Fatalf("gap %d s: right-area stroke reaches x=%.1f", gap, p.X)
			}
		}
	}

	// Exactly 30 s: one part. The connector between the areas is real ground
	// then, so the result is one stroke.
	traceA := v2Trace(0, areaA)
	traceB := v2Trace(traceA[len(traceA)-1].Ts+30, areaB)
	shape, ok := ComputeV2(append(traceA, traceB...))
	if !ok {
		t.Fatal("30 s gap: ComputeV2 returned no shape")
	}
	if len(shape.Strokes) != 1 {
		t.Fatalf("30 s gap: want a single stroke, got %d", len(shape.Strokes))
	}

	// A lone fix between two gaps is a one-point part: no stroke of its own.
	lone := Sample{Lat: trackLat0 - 2.0/111_000.0, Lon: trackLon0 + 5.0/(111_000*math.Cos(trackLat0*math.Pi/180)), OK: true, Ts: traceA[len(traceA)-1].Ts + 40}
	traceB = v2Trace(lone.Ts+40, areaB)
	shape, ok = ComputeV2(append(append(traceA, lone), traceB...))
	if !ok {
		t.Fatal("lone-fix trace: ComputeV2 returned no shape")
	}
	if len(shape.Strokes) != 2 {
		t.Fatalf("lone fix drew its own stroke: %d strokes", len(shape.Strokes))
	}
}

// An open route whose real endpoint merely passes near a drawn road keeps that
// endpoint open: proximity alone never joins (epic: 真实终点贴近另一条路).
func TestComputeV2RealEndpointNearRoadStaysOpen(t *testing.T) {
	shape, ok := ComputeV2(v2Trace(1000,
		[][2]float64{{0, 0}, {90, 0}, {90, 60}, {0, 60}, {0, 0}},
		[][2]float64{{0, 0}, {45, 0}},
		[][2]float64{{45, 0}, {45, 58}}, // ends 2 units short of the top edge
	))
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, shape, "open end")
	decoded := v2RoundTrip(t, shape)

	var spur []Point
	for _, stroke := range decoded.Strokes[1:] {
		if v2StrokeLength(stroke) > v2StrokeLength(spur) {
			spur = stroke
		}
	}
	if len(spur) == 0 {
		t.Fatal("no spur stroke found")
	}
	if !v2SharedVertex(spur[0], decoded.Strokes[0]) {
		t.Fatalf("spur entry %+v is not shared with the outer stroke", spur[0])
	}
	end := spur[len(spur)-1]
	// The end must be the trace's real endpoint: 2 design units from the top
	// edge — near, but never glued onto it.
	if got := v2DistanceToStroke(end, decoded.Strokes[0]); got < 1.0 {
		t.Fatalf("real endpoint %+v sits %.2f from the outer stroke — glued on", end, got)
	}
	if got := v2DistanceToStroke(end, decoded.Strokes[0]); got > 3.5 {
		t.Fatalf("real endpoint %+v drifted %.1f from its design position", end, got)
	}
}

// Two parallel roads drawn in one pass, then a spur off one that stops just
// short of the other: the spur must attach exactly to the road it left and
// must NOT attach to the parallel road it dies near — the offset gate alone
// would allow it (0.9 < 1.85); the evidence-local cost must refuse (epic:
// 相邻平行道路).
func TestComputeV2ParallelRoadNotMisJoined(t *testing.T) {
	shape, ok := ComputeV2(v2Trace(1000,
		[][2]float64{{0, 0}, {90, 0}, {90, 3}, {0, 3}, {0, 0}}, // both roads, drawn
		[][2]float64{{0, 0}, {40, 0}},                          // covered re-run, omitted
		[][2]float64{{40, 0}, {40, 2.1}},                       // spur: dies 0.9 short of the upper road
		[][2]float64{{40, 2.1}, {40, 0}},                       // return, omitted
		[][2]float64{{40, 0}, {0, 0}},                          // covered re-run, omitted
	))
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, shape, "parallel")
	decoded := v2RoundTrip(t, shape)

	if len(decoded.Strokes) != 2 {
		t.Fatalf("want 2 strokes (roads + spur), got %d", len(decoded.Strokes))
	}
	roads, spur := decoded.Strokes[0], decoded.Strokes[1]
	if got := v2StrokeLength(roads); got < 170 {
		t.Fatalf("roads stroke length %.1f — both roads must be drawn", got)
	}
	if !v2SharedVertex(spur[0], roads) {
		t.Fatalf("spur entry %+v is not an exact vertex of the road stroke", spur[0])
	}
	tip := spur[len(spur)-1]
	if v2SharedVertex(tip, roads) {
		t.Fatalf("spur tip %+v was joined to the parallel road", tip)
	}
	// Design distance from the tip to the upper road (y=3) is 0.9.
	if got := v2DistanceToStroke(tip, roads); got < 0.5 {
		t.Fatalf("spur tip %+v sits %.2f from the roads stroke — mis-joined", tip, got)
	}
}

// A single pass along a real bend keeps the bend: the drawn polyline must stay
// within the refinement tolerance of the arc, where a single chord deviates by
// ~11.7 units (epic "弯道与覆盖").
func TestComputeV2PreservesCurveFidelity(t *testing.T) {
	// Quarter arc of radius 40 from (0,0) to (40,40), then straight to (90,40).
	var arc [][2]float64
	for i := 0; i <= 18; i++ {
		angle := math.Pi / 2 * float64(i) / 18
		arc = append(arc, [2]float64{40 * math.Sin(angle), 40 - 40*math.Cos(angle)})
	}
	ideal := append(arc, [2]float64{90, 40})

	shape, ok := ComputeV2(v2Trace(1000, ideal))
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, shape, "curve")
	decoded := v2RoundTrip(t, shape)

	if decoded.TotalPoints() < 7 {
		t.Fatalf("%d points — the arc was chorded away", decoded.TotalPoints())
	}
	// Endpoints are the trace's real first/last fix, shared exactly with the
	// stroke's ends.
	if decoded.Strokes[0][0] != decoded.Start {
		t.Fatalf("stroke start %+v != real start %+v", decoded.Strokes[0][0], decoded.Start)
	}
	last := decoded.Strokes[0][len(decoded.Strokes[0])-1]
	if last != decoded.End {
		t.Fatalf("stroke end %+v != real end %+v", last, decoded.End)
	}

	// Two-way error against the ideal geometry, both densified at 0.2 units.
	refView := make([]pt, 0, len(ideal))
	for _, c := range ideal {
		refView = append(refView, pt{c[0] + 5, 70 - c[1]}) // exact view map: y' = 70 - y for y in [0,40]
	}
	ref := v2SamplesAlong([][]pt{refView}, v2SampleStep)
	drawn := make([][]pt, len(decoded.Strokes))
	for i, stroke := range decoded.Strokes {
		drawn[i] = make([]pt, len(stroke))
		for j, p := range stroke {
			drawn[i][j] = pt{p.X, p.Y}
		}
	}
	if err := v2Hausdorff(ref, v2SamplesAlong(drawn, v2SampleStep)); err > 0.6 {
		t.Fatalf("drawn vs ideal error %.2f exceeds the 0.6-unit bound", err)
	}
}

// v2OvalTrace builds a multi-lap wobbled oval (design semi-axes 45x25, so the
// span is ~90 units).
func v2OvalTrace(laps int) []Sample {
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))
	var samples []Sample
	ts := int64(0)
	for lap := 0; lap < laps; lap++ {
		for i := 0; i < 64; i++ {
			angle := 2 * math.Pi * float64(i) / 64
			x := 45*math.Cos(angle) + 0.25*math.Sin(float64(lap)*0.7+angle*3)
			y := 25*math.Sin(angle) + 0.25*math.Cos(float64(lap)*0.5+angle*2)
			samples = append(samples, Sample{
				Lat: trackLat0 + y*latPerMeter,
				Lon: trackLon0 + x*lonPerMeter,
				OK:  true,
				Ts:  ts,
			})
			ts++
		}
	}
	return samples
}

// Repeated laps draw once: the drawn length stays near one lap however many
// laps the trace holds, while Travel — the width metric — keeps counting them.
func TestComputeV2RepeatedLapsDrawOnce(t *testing.T) {
	const laps = 12
	shape, ok := ComputeV2(v2OvalTrace(laps))
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, shape, "laps")
	decoded := v2RoundTrip(t, shape)

	drawn := 0.0
	for _, stroke := range decoded.Strokes {
		drawn += v2StrokeLength(stroke)
	}
	// One lap of the 45x25 oval is ~224 units; wobble and anchors may add a
	// little, twelve laps would be ~2700.
	if drawn > 300 {
		t.Fatalf("drawn length %.0f — the laps were retraced", drawn)
	}
	if decoded.Travel < 2400 {
		t.Fatalf("travel %.0f — the pre-dedup travel must count all %d laps", decoded.Travel, laps)
	}
}

// Over-budget complexity degrades deterministically: the tolerance search
// runs first, then the shortest (least significant, most anomalous) runs are
// dropped until the budget holds. The long structure survives.
func TestComputeV2OverBudgetDropsLeastSignificantRuns(t *testing.T) {
	loop := [][2]float64{{0, 0}, {90, 0}, {90, 60}, {0, 60}, {0, 0}}
	legs := [][][2]float64{loop}

	var longSpurs, tinySpurs int
	prev := [2]float64{0, 0}
	for x := 2.0; x <= 88.0; x += 3.0 {
		var spurTop float64
		if x == 14 || x == 44 || x == 74 {
			spurTop = 52 // long spur, ~52 units
			longSpurs++
		} else {
			spurTop = 1.5 // tiny spur
			tinySpurs++
		}
		base := [2]float64{x, 0}
		legs = append(legs,
			[][2]float64{prev, base},         // covered re-run along the bottom
			[][2]float64{base, {x, spurTop}}, // spur out, drawn
			[][2]float64{{x, spurTop}, base}, // spur back, omitted
		)
		prev = base
	}
	legs = append(legs, [][2]float64{prev, {0, 0}}) // return along the bottom

	trace := v2Trace(1000, legs...)
	first, ok := ComputeV2(trace)
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, first, "over budget")

	// Deterministic: the same input yields the identical output.
	second, _ := ComputeV2(trace)
	if EncodeV2(first) != EncodeV2(second) {
		t.Fatal("degradation is not deterministic")
	}

	decoded := v2RoundTrip(t, first)
	longSurvivors := 0
	loopSurvives := false
	for _, stroke := range decoded.Strokes {
		switch l := v2StrokeLength(stroke); {
		case l >= 280:
			loopSurvives = true
		case l >= 40:
			longSurvivors++
		}
	}
	if !loopSurvives {
		t.Fatal("the main loop was dropped")
	}
	if longSurvivors != longSpurs {
		t.Fatalf("%d of %d long spurs survived the degradation", longSurvivors, longSpurs)
	}
	if len(decoded.Strokes) < longSpurs+1 {
		t.Fatalf("want at least %d strokes, got %d", longSpurs+1, len(decoded.Strokes))
	}
}

// Extreme inputs degrade to "nothing drawable" rather than panicking or
// emitting junk: too few fixes, no valid fixes, a zero-extent trace, a trace
// of scattered single-fix parts. Missing timestamps never split.
func TestComputeV2ExtremeInputs(t *testing.T) {
	if _, ok := ComputeV2(nil); ok {
		t.Fatal("nil samples should not produce a shape")
	}
	if _, ok := ComputeV2(v2Trace(0, [][2]float64{{0, 0}, {3, 0}})); ok {
		t.Fatal("a 9-fix trace is below the cutoff")
	}
	if _, ok := ComputeV2([]Sample{{Lat: trackLat0, Lon: trackLon0, OK: false}}); ok {
		t.Fatal("no valid fixes should not produce a shape")
	}

	// 15 fixes at the same spot: extent zero.
	same := make([]Sample, 15)
	for i := range same {
		same[i] = Sample{Lat: trackLat0, Lon: trackLon0, OK: true, Ts: int64(i)}
	}
	if _, ok := ComputeV2(same); ok {
		t.Fatal("a zero-extent trace should not produce a shape")
	}

	// 12 fixes, each 40 s apart, each somewhere else: every part is a single
	// point, nothing can be drawn.
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))
	scattered := make([]Sample, 12)
	for i := range scattered {
		x := float64(i) * 8.0
		y := float64(i%3) * 30.0
		scattered[i] = Sample{Lat: trackLat0 + y*latPerMeter, Lon: trackLon0 + x*lonPerMeter, OK: true, Ts: 1000 + int64(i)*40}
	}
	if _, ok := ComputeV2(scattered); ok {
		t.Fatal("single-fix parts should not produce a shape")
	}

	// No timestamps at all: one part, still drawable.
	arc := v2Trace(0, [][2]float64{{0, 0}, {90, 0}, {90, 60}, {0, 60}, {0, 0}})
	for i := range arc {
		arc[i].Ts = 0
	}
	shape, ok := ComputeV2(arc)
	if !ok {
		t.Fatal("a trace without timestamps should still draw")
	}
	if len(shape.Strokes) != 1 {
		t.Fatalf("trace without timestamps: want 1 stroke, got %d", len(shape.Strokes))
	}
}

func TestEncodeV2Format(t *testing.T) {
	shape := &ShapeV2{
		Strokes: [][]Point{{{X: 5, Y: 95}, {X: 95.1, Y: 4.5}}},
		Start:   Point{X: 5, Y: 95},
		End:     Point{X: 95.1, Y: 4.5},
		Short:   8.4,
		Long:    63.1,
		Travel:  412.3,
	}
	want := `{"v":2,"strokes":[[[5.0,95.0],[95.1,4.5]]],"start":[5.0,95.0],"end":[95.1,4.5],"short":8.4,"long":63.1,"travel":412.3}`
	got := EncodeV2(shape)
	if got != want {
		t.Fatalf("EncodeV2:\n got %s\nwant %s", got, want)
	}
	if !strings.Contains(got, `"v":2`) {
		t.Fatal("encoded shape must carry the version marker")
	}
}

func TestDecodeV2RejectsBadInput(t *testing.T) {
	for name, in := range map[string]string{
		"legacy v1 array":  `[[5.0,95.0],[50.0,50.0]]`,
		"wrong version":    `{"v":1,"strokes":[[[5.0,95.0],[50.0,50.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}`,
		"no strokes":       `{"v":2,"strokes":[],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}`,
		"1-point stroke":   `{"v":2,"strokes":[[[5.0,95.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}`,
		"out of viewbox":   `{"v":2,"strokes":[[[5.0,95.0],[105.0,50.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":1.0,"long":2.0,"travel":3.0}`,
		"negative metric":  `{"v":2,"strokes":[[[5.0,95.0],[50.0,50.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":-1.0,"long":2.0,"travel":3.0}`,
		"short above long": `{"v":2,"strokes":[[[5.0,95.0],[50.0,50.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":5.0,"long":2.0,"travel":3.0}`,
		"garbage":          `not json`,
	} {
		if _, err := DecodeV2(in); err == nil {
			t.Fatalf("%s: DecodeV2 should have failed", name)
		}
	}

	// Short==0 (straight-line trace) is legal — it means "never narrow".
	good := `{"v":2,"strokes":[[[5.0,95.0],[50.0,50.0]]],"start":[5.0,95.0],"end":[50.0,50.0],"short":0.0,"long":90.0,"travel":180.0}`
	if _, err := DecodeV2(good); err != nil {
		t.Fatalf("straight-line shape should decode: %v", err)
	}
}

// StrokeWidth ports the prototype's small_width: only narrow, repeatedly
// travelled routes thin at small sizes; big displays always get the regular
// width; degenerate (straight) routes never thin.
func TestStrokeWidth(t *testing.T) {
	cases := []struct {
		name                      string
		size, short, long, travel float64
		want                      float64
	}{
		{"36 px regular", 36, 60, 90, 300, 1.2},
		{"36 px thin", 36, 8, 90, 260, 0.9},
		{"56 px and up never thin", 64, 8, 90, 260, 64.0 / 30},
		{"straight trace never thins", 36, 0, 90, 300, 1.2},
		{"short route does not thin", 36, 20, 90, 100, 1.2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := StrokeWidth(tc.size, tc.short, tc.long, tc.travel); math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("StrokeWidth(%v, %v, %v, %v) = %v, want %v", tc.size, tc.short, tc.long, tc.travel, got, tc.want)
			}
		})
	}
}

// The width metrics must come from the rotating rectangle, not the axis-aligned
// bounding box: a long thin route laid out diagonally has a square bbox but a
// thin rotating rectangle, and it must count as narrow.
func TestComputeV2WidthMetricsUseRotatingRectangle(t *testing.T) {
	// Out-and-back along the main diagonal with a ±0.8 zigzag, so the band is
	// ~1.6 units wide and ~122 long at 45°.
	var zig [][2]float64
	dir := [2]float64{1 / math.Sqrt2, 1 / math.Sqrt2}
	perp := [2]float64{-dir[1], dir[0]}
	s0, s1 := [2]float64{2, 2}, [2]float64{88, 88}
	for i := 0; i <= 40; i++ {
		t := float64(i) / 40
		base := [2]float64{s0[0] + (s1[0]-s0[0])*t, s0[1] + (s1[1]-s0[1])*t}
		amp := 0.8 * math.Sin(float64(i)*math.Pi/2) // alternates -0.8, 0, +0.8
		zig = append(zig, [2]float64{base[0] + perp[0]*amp, base[1] + perp[1]*amp})
	}
	back := make([][2]float64, len(zig))
	for i, c := range zig {
		back[len(zig)-1-i] = c
	}

	shape, ok := ComputeV2(v2Trace(1000, zig, back))
	if !ok {
		t.Fatal("ComputeV2 returned no shape")
	}
	v2CheckShapeInvariants(t, shape, "diagonal")
	decoded := v2RoundTrip(t, shape)

	// The axis-aligned bbox of a 45° band is square; the rotating rectangle
	// must see the thin truth.
	if decoded.Short/decoded.Long > 0.15 {
		t.Fatalf("rotating-rect ratio %.2f — a ~1.6x122 band must read as narrow", decoded.Short/decoded.Long)
	}
	// 36 px: narrow + out-and-back (travel ~ 2x the long side) => thinned.
	if got := StrokeWidth(36, decoded.Short, decoded.Long, decoded.Travel); got > 0.95 {
		t.Fatalf("36 px width %.2f — a narrow out-and-back must thin below 0.95", got)
	}
	// 64 px: back to the regular width.
	if got := StrokeWidth(64, decoded.Short, decoded.Long, decoded.Travel); math.Abs(got-64.0/30) > 1e-9 {
		t.Fatalf("64 px width %.2f, want the regular %.2f", got, 64.0/30)
	}
}

// Every shape this suite produces must fit the storage budget — the assertion
// the epic runs over all 20 real routes, pinned here over the synthetic ones.
func TestComputeV2AllShapesFitBudget(t *testing.T) {
	traces := map[string][]Sample{}
	traces["junction"] = v2Trace(1000,
		[][2]float64{{0, 0}, {90, 0}, {90, 60}, {0, 60}, {0, 0}},
		[][2]float64{{0, 0}, {45, 0}},
		[][2]float64{{45, 0}, {45, 60}},
		[][2]float64{{45, 60}, {0, 60}},
		[][2]float64{{0, 60}, {0, 0}},
	)
	traces["gap"] = append(
		v2Trace(0, [][2]float64{{0, 0}, {30, 0}, {30, 30}, {0, 30}, {0, 0}}),
		v2Trace(200, [][2]float64{{60, 0}, {90, 0}, {90, 30}, {60, 30}, {60, 0}})...,
	)
	traces["oval 12 laps"] = v2OvalTrace(12)
	traces["oval 40 laps"] = v2OvalTrace(40)
	for name, trace := range traces {
		t.Run(name, func(t *testing.T) {
			shape, ok := ComputeV2(trace)
			if !ok {
				t.Fatal("ComputeV2 returned no shape")
			}
			v2CheckShapeInvariants(t, shape, name)
			v2RoundTrip(t, shape)
		})
	}
}
