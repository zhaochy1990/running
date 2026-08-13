package racedetection

import (
	"math"
	"testing"
)

func TestAnalyzeRouteDetectsSmallRepeatedLoopFromFullTrace(t *testing.T) {
	trace := syntheticLoopTrace(40, 80, 95, 55)
	analysis := AnalyzeRoute(trace)
	if analysis.Shape != RouteShapeSmallRepeatedLoop {
		t.Fatalf("route analysis = %+v, want small repeated loop", analysis)
	}
	if analysis.ValidPoints != len(trace) || analysis.PathToPerimeter < repeatedRoutePathToPerimeter {
		t.Fatalf("route metrics = %+v", analysis)
	}
}

func TestAnalyzeRouteDetectsOutAndBack(t *testing.T) {
	const pointsPerLeg = 1000
	trace := make([]TracePoint, 0, pointsPerLeg*2+1)
	for i := 0; i <= pointsPerLeg*2; i++ {
		position := i
		if i > pointsPerLeg {
			position = pointsPerLeg*2 - i
		}
		trace = append(trace, tracePointMeters(float64(position)*10, 15*math.Sin(float64(position)/30)))
	}
	analysis := AnalyzeRoute(trace)
	if analysis.Shape != RouteShapeOutAndBack || analysis.OutAndBackMatchRatio < outAndBackMinMatchRatio {
		t.Fatalf("route analysis = %+v, want out and back", analysis)
	}
}

func TestAnalyzeRouteDetectsHighlyRepeatedCompactCourseWithoutLoopFootprint(t *testing.T) {
	trace := make([]TracePoint, 0, 5_000)
	for lap := 0; lap < 50; lap++ {
		for i := 0; i < 100; i++ {
			x := float64(i) * 4
			if lap%2 == 1 {
				x = 396 - x
			}
			trace = append(trace, tracePointMeters(x, float64(lap%5)*50))
		}
	}
	analysis := AnalyzeRoute(trace)
	if analysis.Shape != RouteShapeSmallRepeatedLoop || analysis.SpatialRevisitRatio < repeatedRouteMinRevisitRatio {
		t.Fatalf("route analysis = %+v, want highly repeated compact course", analysis)
	}
}

func TestAnalyzeRouteIgnoresIsolatedGPSJumpForAllMetrics(t *testing.T) {
	trace := syntheticLoopTrace(40, 80, 95, 55)
	jump := tracePointMeters(20_000, 20_000)
	trace = append(trace[:1_000], append([]TracePoint{jump}, trace[1_000:]...)...)
	analysis := AnalyzeRoute(trace)
	if analysis.Shape != RouteShapeSmallRepeatedLoop || analysis.IgnoredJumpPoints != 1 {
		t.Fatalf("route analysis = %+v, want compact loop with one ignored jump", analysis)
	}
	if analysis.BoundingWidthM > repeatedRouteMaxBBoxM || analysis.BoundingHeightM > repeatedRouteMaxBBoxM {
		t.Fatalf("jump polluted route bounds: %+v", analysis)
	}
}

func TestAnalyzeRouteKeepsLongestContinuousSegmentAcrossGPSGap(t *testing.T) {
	longLoop := syntheticLoopTrace(40, 80, 95, 55)
	shortTail := []TracePoint{tracePointMeters(15_000, 15_000), tracePointMeters(15_100, 15_100)}
	analysis := AnalyzeRoute(append(longLoop, shortTail...))
	if analysis.Shape != RouteShapeSmallRepeatedLoop || analysis.IgnoredJumpPoints != len(shortTail) {
		t.Fatalf("route analysis = %+v, want longest compact segment", analysis)
	}
}

func TestAnalyzeRouteDetectsLargeLoopAndPointToPoint(t *testing.T) {
	t.Run("large loop", func(t *testing.T) {
		analysis := AnalyzeRoute(syntheticLoopTrace(1, 720, 4_000, 2_500))
		if analysis.Shape != RouteShapeLargeLoopOrPointToPoint {
			t.Fatalf("route analysis = %+v", analysis)
		}
	})
	t.Run("point to point", func(t *testing.T) {
		trace := make([]TracePoint, 1001)
		for i := range trace {
			trace[i] = tracePointMeters(float64(i)*20, 200*math.Sin(float64(i)/100))
		}
		analysis := AnalyzeRoute(trace)
		if analysis.Shape != RouteShapeLargeLoopOrPointToPoint {
			t.Fatalf("route analysis = %+v", analysis)
		}
	})
}

func TestAnalyzeRouteReturnsUnknownForMissingGPS(t *testing.T) {
	if got := AnalyzeRoute([]TracePoint{{}, {}}); got.Shape != RouteShapeUnknown {
		t.Fatalf("route analysis = %+v", got)
	}
}

func syntheticLoopTrace(laps, pointsPerLap int, radiusXM, radiusYM float64) []TracePoint {
	trace := make([]TracePoint, 0, laps*pointsPerLap+1)
	for i := 0; i <= laps*pointsPerLap; i++ {
		angle := 2 * math.Pi * float64(i%pointsPerLap) / float64(pointsPerLap)
		trace = append(trace, tracePointMeters(radiusXM*math.Cos(angle), radiusYM*math.Sin(angle)))
	}
	return trace
}

func tracePointMeters(xM, yM float64) TracePoint {
	const lat0, lon0 = 31.2, 121.4
	lat := lat0 + yM/111_000
	lon := lon0 + xM/(111_000*math.Cos(lat0*math.Pi/180))
	return TracePoint{Latitude: &lat, Longitude: &lon}
}
