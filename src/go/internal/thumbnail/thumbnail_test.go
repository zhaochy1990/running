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

// A loop repeated many times around a park is the common case, not just an oval
// track. With the compact-route cap too low, the trace falls through to uniform
// distance sampling and aliases into a dense scribble whose drawn length is an
// order of magnitude larger than the loop it is meant to show.
func TestComputeParkLoopFoldsToSingleLap(t *testing.T) {
	points, ok := Compute(parkLoopTrace(15, 200))
	if !ok {
		t.Fatal("Compute returned no polyline for a park loop")
	}
	if points[0] != points[len(points)-1] {
		t.Fatalf("park loop should fold to a closed footprint, got %+v ... %+v", points[0], points[len(points)-1])
	}
	// One lap of a ~615x481 m loop inscribed in the 90-unit viewport draws a
	// perimeter in the low hundreds. A scribble that re-crosses the box ~15
	// times lands in the thousands.
	if got := polylineLengthOf(points); got > 500 {
		t.Fatalf("polyline length %.0f — trace aliased instead of folding to one lap", got)
	}
	if got := maxSegment(points); got > 20 {
		t.Fatalf("max segment %.1f exceeds 20", got)
	}
	withinViewport(t, points)
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

// A uniformly skipped multi-lap trace aliases into long chords across the
// infield. The thumbnail must collapse repeated laps into one closed footprint
// whose adjacent segments stay local.
func TestComputeTrackCollapsesLapsIntoLoopFootprint(t *testing.T) {
	points, ok := Compute(trackTrace(25, 48))
	if !ok {
		t.Fatal("Compute returned no polyline for a 25-lap track")
	}
	if len(points) > TargetPoints+1 {
		t.Fatalf("got %d points, want at most %d", len(points), TargetPoints+1)
	}
	if points[0] != points[len(points)-1] {
		t.Fatalf("loop footprint should be closed, got %+v ... %+v", points[0], points[len(points)-1])
	}
	if got := maxSegment(points); got > 20 {
		t.Fatalf("max segment %.1f exceeds 20 — laps aliased into infield chords", got)
	}
	if got := polylineLengthOf(points); got >= 400 {
		t.Fatalf("polyline length %.1f exceeds 400", got)
	}
	withinViewport(t, points)
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

// A compact switchback out-and-back covers many angles in a small box, but it is
// not a loop: closing it would draw a phantom edge across the turnaround.
func TestComputeCompactSwitchbackStaysOpen(t *testing.T) {
	latPerMeter := 1 / 111_000.0
	lonPerMeter := 1 / (111_000 * math.Cos(trackLat0*math.Pi/180))

	samples := make([]Sample, 0, 12*40)
	for rep := range 12 {
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

	points, ok := Compute(samples)
	if !ok {
		t.Fatal("Compute returned no polyline for a switchback route")
	}
	if points[0] == points[len(points)-1] {
		t.Fatalf("switchback route should not be closed: %+v", points[0])
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
