package thumbnail

import (
	"bytes"
	"image/color"
	"image/png"
	"math"
	"testing"
)

const (
	trackLat0 = 31.2
	trackLon0 = 121.4
)

// trackTrace builds a synthetic multi-lap GPS trace around a 400m-style track.
// Ported from tests/stride_core/test_route_thumbnail.py so both implementations
// are held to the same shape.
func trackTrace(laps, samplesPerLap int) []Sample {
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))

	samples := make([]Sample, 0, laps*samplesPerLap)
	for lap := range laps {
		for i := range samplesPerLap {
			angle := 2 * math.Pi * (float64(i) / float64(samplesPerLap))
			// Oval footprint with tiny deterministic wobble to mimic GPS/lane noise.
			xM := 95*math.Cos(angle) + 1.5*math.Sin(float64(lap)*0.7+angle*3)
			yM := 55*math.Sin(angle) + 1.0*math.Cos(float64(lap)*0.5+angle*2)
			samples = append(samples, Sample{
				Lat: trackLat0 + yM*latPerMeter,
				Lon: trackLon0 + xM*lonPerMeter,
				OK:  true,
			})
		}
	}
	return samples
}

// parkLoopTrace builds a synthetic multi-lap trace around an irregular
// park-sized loop (~615x481 m). Modelled on a real 32 km run of ~15 laps that
// the original 600 m compact-route cap misclassified, aliasing the trace into a
// dense scribble instead of one lap.
func parkLoopTrace(laps, samplesPerLap int) []Sample {
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))

	// Irregular pentagon spanning 614 m east-west and 480 m north-south.
	shape := [][2]float64{
		{307, 0}, {95, -240}, {-307, -60}, {-180, 240}, {150, 200},
	}
	// Cumulative edge lengths, for even sampling around the perimeter.
	edges := make([]float64, len(shape))
	var perimeter float64
	for i := range shape {
		a, b := shape[i], shape[(i+1)%len(shape)]
		edges[i] = math.Hypot(b[0]-a[0], b[1]-a[1])
		perimeter += edges[i]
	}

	samples := make([]Sample, 0, laps*samplesPerLap)
	for lap := range laps {
		for i := range samplesPerLap {
			// Walk the perimeter by arc length, so laps are evenly covered.
			want := perimeter * float64(i) / float64(samplesPerLap)
			var xM, yM float64
			for e := range shape {
				if want <= edges[e] || e == len(shape)-1 {
					a, b := shape[e], shape[(e+1)%len(shape)]
					t := want / edges[e]
					xM, yM = a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t
					break
				}
				want -= edges[e]
			}
			samples = append(samples, Sample{
				Lat: trackLat0 + (yM+1.5*math.Sin(float64(lap)*0.9+float64(i)))*latPerMeter,
				Lon: trackLon0 + (xM+1.5*math.Cos(float64(lap)*0.7+float64(i)))*lonPerMeter,
				OK:  true,
			})
		}
	}
	return samples
}

// A loop covered many times must not be DRAWN many times. The reduction keeps the
// ground the trace covers, so the drawn length stays near one lap however many
// laps the trace holds. This is the property plain distance-thinning broke, and
// it is what makes a repeat-heavy route readable.
func TestComputeRepeatedLoopDoesNotRetrace(t *testing.T) {
	for _, tc := range []struct {
		name     string
		trace    []Sample
		maxSeg   float64
		maxTotal float64
	}{
		// One lap inscribed in the 90-unit viewport draws a few hundred units;
		// drawing every lap lands in the thousands.
		{"oval track, 25 laps", trackTrace(25, 48), 30, 500},
		{"park loop, 15 laps", parkLoopTrace(15, 200), 30, 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			points, ok := Compute(tc.trace)
			if !ok {
				t.Fatal("Compute returned no polyline")
			}
			if got := polylineLengthOf(points); got > tc.maxTotal {
				t.Fatalf("polyline length %.0f — the trace retraced instead of collapsing", got)
			}
			if got := maxSegment(points); got > tc.maxSeg {
				t.Fatalf("max segment %.1f exceeds %.0f", got, tc.maxSeg)
			}
			withinViewport(t, points)
		})
	}
}

// chordLoopTrace models the venue pattern that dominated a real athlete's
// history: a small (~400x400 m) loop with a spur cut across the middle — a
// shortcut through the park. Pass withChord=false for the same loop walked
// without it; the outer boundary is identical either way.
func chordLoopTrace(laps int, withChord bool) []Sample {
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))

	const samplesPerLap = 200
	// The outer boundary is IDENTICAL with and without the spur — that is the
	// whole point: only the extra leg changes, so any difference in the result is
	// the spur leaking into (or out of) the outline.
	v3 := [2]float64{-195, -50} // boundary vertex the detour leaves from
	in := [2]float64{-30, -20}  // well inside the loop
	shape := [][2]float64{
		{190, 110}, {150, -190}, {-70, -200}, v3, {-110, 180}, {170, 150},
	}
	if withChord {
		// Out to the interior point and straight back, appended after v3.
		shape = append(shape[:4:4], append([][2]float64{in, v3}, shape[4:]...)...)
	}
	edges := make([]float64, len(shape))
	var perimeter float64
	for i := range shape {
		a, b := shape[i], shape[(i+1)%len(shape)]
		edges[i] = math.Hypot(b[0]-a[0], b[1]-a[1])
		perimeter += edges[i]
	}

	samples := make([]Sample, 0, laps*samplesPerLap)
	for lap := range laps {
		for i := range samplesPerLap {
			want := perimeter * float64(i) / float64(samplesPerLap)
			var xM, yM float64
			for e := range shape {
				if want <= edges[e] || e == len(shape)-1 {
					a, b := shape[e], shape[(e+1)%len(shape)]
					t := want / edges[e]
					xM, yM = a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t
					break
				}
				want -= edges[e]
			}
			samples = append(samples, Sample{
				Lat: trackLat0 + (yM+1.2*math.Sin(float64(lap)*0.8+float64(i)))*latPerMeter,
				Lon: trackLon0 + (xM+1.2*math.Cos(float64(lap)*0.6+float64(i)))*lonPerMeter,
				OK:  true,
			})
		}
	}
	return samples
}

// The reduction keeps whatever the trace did uniquely. A spur cut across the loop
// on a couple of laps out of many must still be drawn, and a loop with no such
// spur must not grow a phantom one.
//
// This is the property both earlier attempts lost. Collapsing the loop into one
// averaged footprint pulled the spur into the perimeter as a dent; taking the
// outer envelope instead deleted the spur outright. Neither is acceptable — the
// activity map shows the spur, so a thumbnail that drops it looks wrong to the
// person who ran it.
func TestComputeKeepsUniqueSpur(t *testing.T) {
	// How close the shape comes to its own centre: a loop stays out on its
	// perimeter, a spur reaches in.
	closestApproach := func(points []Point) float64 {
		minX, maxX, minY, maxY := points[0].X, points[0].X, points[0].Y, points[0].Y
		for _, p := range points {
			minX, maxX = math.Min(minX, p.X), math.Max(maxX, p.X)
			minY, maxY = math.Min(minY, p.Y), math.Max(maxY, p.Y)
		}
		cx, cy := (minX+maxX)/2, (minY+maxY)/2
		best := math.Inf(1)
		for _, p := range points {
			best = math.Min(best, math.Hypot(p.X-cx, p.Y-cy))
		}
		return best
	}

	withSpur, ok := Compute(chordLoopTrace(15, true))
	if !ok {
		t.Fatal("no polyline for the loop with the spur")
	}
	withoutSpur, ok := Compute(chordLoopTrace(15, false))
	if !ok {
		t.Fatal("no polyline for the loop without the spur")
	}

	spurred, plain := closestApproach(withSpur), closestApproach(withoutSpur)
	t.Logf("closest approach to centre: with spur %.1f, without %.1f", spurred, plain)
	if spurred >= plain {
		t.Fatalf("the spur did not survive the reduction: %.1f vs %.1f", spurred, plain)
	}
	if plain < 25 {
		t.Fatalf("a plain loop reached %.1f units from its centre — phantom interior", plain)
	}

	// It must also still not retrace: the spur was taken on every lap here, so
	// keeping them all would land in the thousands.
	if got := polylineLengthOf(withSpur); got > 500 {
		t.Fatalf("polyline length %.0f — the repeated spur was drawn every lap", got)
	}
	withinViewport(t, withSpur)
}

func polylineLengthOf(points []Point) float64 {
	var total float64
	for i := 1; i < len(points); i++ {
		total += math.Hypot(points[i].X-points[i-1].X, points[i].Y-points[i-1].Y)
	}
	return total
}

func maxSegment(points []Point) float64 {
	worst := 0.0
	for i := 1; i < len(points); i++ {
		worst = math.Max(worst, math.Hypot(points[i].X-points[i-1].X, points[i].Y-points[i-1].Y))
	}
	return worst
}

func withinViewport(t *testing.T, points []Point) {
	t.Helper()
	for i, p := range points {
		if p.X < Padding-0.05 || p.X > Viewbox-Padding+0.05 || p.Y < Padding-0.05 || p.Y > Viewbox-Padding+0.05 {
			t.Fatalf("point %d out of padded viewport: %+v", i, p)
		}
	}
}

// The result must fit the budget it is stored and shipped under.
func TestComputeFitsPointBudget(t *testing.T) {
	for _, trace := range [][]Sample{trackTrace(25, 48), parkLoopTrace(15, 200), chordLoopTrace(15, true)} {
		points, ok := Compute(trace)
		if !ok {
			t.Fatal("Compute returned no polyline")
		}
		if len(points) > TargetPoints {
			t.Fatalf("got %d points, want at most %d", len(points), TargetPoints)
		}
	}
}

// Aspect ratio must survive the projection: an oval track is wider than it is
// tall, and so must be the thumbnail.
func TestComputePreservesAspectRatio(t *testing.T) {
	points, ok := Compute(trackTrace(25, 48))
	if !ok {
		t.Fatal("Compute returned no polyline")
	}
	minX, maxX, minY, maxY := points[0].X, points[0].X, points[0].Y, points[0].Y
	for _, p := range points {
		minX, maxX = math.Min(minX, p.X), math.Max(maxX, p.X)
		minY, maxY = math.Min(minY, p.Y), math.Max(maxY, p.Y)
	}
	gotRatio := (maxX - minX) / (maxY - minY)
	wantRatio := 190.0 / 110.0 // semi-axes 95 x 55 in the synthetic trace
	if math.Abs(gotRatio-wantRatio) > 0.15 {
		t.Fatalf("aspect ratio %.2f, want ~%.2f", gotRatio, wantRatio)
	}
}

func TestComputeOpenRouteStaysOpen(t *testing.T) {
	samples := make([]Sample, 0, 90)
	for i := range 90 {
		samples = append(samples, Sample{
			Lat: trackLat0 + float64(i)*0.0001,
			Lon: trackLon0 + math.Sin(float64(i)/4)*0.0002,
			OK:  true,
		})
	}

	points, ok := Compute(samples)
	if !ok {
		t.Fatal("Compute returned no polyline for an open route")
	}
	if points[0] == points[len(points)-1] {
		t.Fatalf("open route should not be closed: %+v", points[0])
	}
	withinViewport(t, points)
}

// switchbackTrace sweeps up and down a 280 m stretch `reps` times, drifting 4 m
// sideways per pass — a shuttle or hill-repeat pattern in a compact box.
func switchbackTrace(reps int) []Sample {
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))

	samples := make([]Sample, 0, reps*40)
	for rep := range reps {
		for i := range 40 {
			xM := -140 + float64(i)*(280.0/39)
			yM := float64(rep) * 4
			if rep%2 == 1 {
				xM = -xM
			}
			samples = append(samples, Sample{
				Lat: trackLat0 + yM*latPerMeter,
				Lon: trackLon0 + xM*lonPerMeter,
				OK:  true,
			})
		}
	}
	return samples
}

// A route crossed only a few times must stay an OPEN polyline: the reduction
// must not close it and invent an edge across each turnaround.
//
// Note this no longer covers a MANY-pass sweep (~12 reps). Such a sweep is a
// route whose ground is covered over and over, so it reduces like any repeated
// route — and the reduction closing it costs nothing, since a 4 m drift over
// 280 m renders as the same flat band either way.
func TestComputeCompactSinglePassRouteStaysOpen(t *testing.T) {
	points, ok := Compute(switchbackTrace(4))
	if !ok {
		t.Fatal("Compute returned no polyline for a compact sweep")
	}
	if points[0] == points[len(points)-1] {
		t.Fatalf("a route crossed only a few times should not be closed: %+v", points[0])
	}
}

func TestComputeRejectsTooFewSamples(t *testing.T) {
	if _, ok := Compute(nil); ok {
		t.Fatal("nil samples should not produce a polyline")
	}
	if _, ok := Compute(trackTrace(1, MinGPSSamples-1)); ok {
		t.Fatalf("%d samples should be below the cutoff", MinGPSSamples-1)
	}
}

func TestComputeFiltersInvalidSamples(t *testing.T) {
	samples := []Sample{
		{OK: false},                             // NULL fix
		{Lat: 0, Lon: 0, OK: true},              // null island
		{Lat: 91, Lon: 121, OK: true},           // |lat| > 90
		{Lat: 31.2, Lon: 181, OK: true},         // |lon| > 180
		{Lat: math.NaN(), Lon: 121.4, OK: true}, // NaN
		{Lat: -1e9, Lon: 121.4, OK: true},       // absurd latitude
	}
	good := trackTrace(1, MinGPSSamples)
	points, ok := Compute(append(samples, good...))
	if !ok {
		t.Fatal("valid samples should still produce a polyline after filtering")
	}
	// The junk rows sit ~thousands of km away; if any survived, the aspect-correct
	// fit would squash the real track into a sliver. All valid fixes came from one
	// lap of the oval, so the shape must still be roughly the oval's aspect.
	minX, maxX, minY, maxY := points[0].X, points[0].X, points[0].Y, points[0].Y
	for _, p := range points {
		minX, maxX = math.Min(minX, p.X), math.Max(maxX, p.X)
		minY, maxY = math.Min(minY, p.Y), math.Max(maxY, p.Y)
	}
	if maxX-minX < 50 || maxY-minY < 30 {
		t.Fatalf("filtered polyline collapsed to a sliver: %.1f x %.1f", maxX-minX, maxY-minY)
	}
}

func TestJSONMatchesPythonFormat(t *testing.T) {
	got := JSON([]Point{{X: 5, Y: 95}, {X: 95.1, Y: 4.5}})
	if want := "[[5.0,95.0],[95.1,4.5]]"; got != want {
		t.Fatalf("JSON() = %s, want %s", got, want)
	}
	if got := JSON(nil); got != "[]" {
		t.Fatalf("JSON(nil) = %s, want []", got)
	}
}

// Activity rows draw the thumbnail inside a circular slot, so a route that runs
// corner to corner must still be wholly inside the inscribed circle. Fitting the
// square instead would clip both ends off a straight diagonal out-and-back.
func TestRenderPNGKeepsCornerToCornerRouteInsideCircularSlot(t *testing.T) {
	// A straight SW->NE trace normalizes to opposite corners of the padded box.
	points := []Point{{X: Padding, Y: Viewbox - Padding}, {X: Viewbox / 2, Y: Viewbox / 2}, {X: Viewbox - Padding, Y: Padding}}

	const size = 96
	raw, err := RenderPNG(points, size, color.RGBA{A: 0xff})
	if err != nil {
		t.Fatalf("RenderPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}

	centre := float64(size) / 2
	ink := 0
	for y := range size {
		for x := range size {
			if _, _, _, a := img.At(x, y).RGBA(); a == 0 {
				continue
			}
			ink++
			if d := math.Hypot(float64(x)+0.5-centre, float64(y)+0.5-centre); d > centre {
				t.Fatalf("ink at (%d,%d) is %.1f from centre, outside the %.0f radius slot", x, y, d, centre)
			}
		}
	}
	if ink == 0 {
		t.Fatal("no stroke pixels drawn")
	}
}

func TestRenderPNGProducesTransparentCanvasWithInk(t *testing.T) {
	points, ok := Compute(trackTrace(25, 48))
	if !ok {
		t.Fatal("Compute returned no polyline")
	}

	raw, err := RenderPNG(points, 96, color.RGBA{R: 0x1f, G: 0x29, B: 0x37, A: 0xff})
	if err != nil {
		t.Fatalf("RenderPNG: %v", err)
	}
	img, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	if b := img.Bounds(); b.Dx() != 96 || b.Dy() != 96 {
		t.Fatalf("canvas %v, want 96x96", b)
	}

	ink, opaque := 0, 0
	for y := range 96 {
		for x := range 96 {
			_, _, _, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}
			opaque++
			r, g, b, _ := img.At(x, y).RGBA()
			if r == 0x1f*257 && g == 0x29*257 && b == 0x37*257 {
				ink++
			}
		}
	}
	if ink == 0 {
		t.Fatal("no stroke pixels drawn")
	}
	// The route is a thin outline, not a fill: most of the canvas stays clear.
	if opaque*2 > 96*96 {
		t.Fatalf("canvas is %d/%d opaque — the polyline looks filled", opaque, 96*96)
	}
}
