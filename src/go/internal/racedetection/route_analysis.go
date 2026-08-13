package racedetection

import (
	"math"
	"sort"
)

// RouteShape is the deterministic topology classification computed from the
// complete GPS trace. The raw trace never needs to leave this package.
type RouteShape string

const (
	RouteShapeUnknown                 RouteShape = "unknown"
	RouteShapeSmallRepeatedLoop       RouteShape = "small_repeated_loop"
	RouteShapeOutAndBack              RouteShape = "out_and_back"
	RouteShapeLargeLoopOrPointToPoint RouteShape = "large_loop_or_point_to_point"

	minRouteGPSPoints                = 10
	repeatedRouteMinPathM            = 1_200.0
	repeatedRouteMaxBBoxM            = 600.0
	repeatedRouteMinBBoxM            = 20.0
	repeatedRoutePathToPerimeter     = 3.0
	repeatedRouteGridSizeM           = 100.0
	repeatedRouteMinRevisitRatio     = 0.60
	maxAdjacentGPSJumpM              = 2_000.0
	outAndBackAnchorStepM            = 250.0
	outAndBackMatchDistanceM         = 150.0
	outAndBackMinMatchRatio          = 0.65
	largeRouteMinSpanM               = 2_000.0
	pointToPointMinEndpointDistanceM = 1_000.0
	closedRouteMaxEndpointDistanceM  = 500.0
)

// RouteAnalysis contains bounded, auditable metrics derived from the complete
// trace. It is suitable for score logs; it contains no coordinates.
type RouteAnalysis struct {
	Shape                RouteShape `json:"shape"`
	ValidPoints          int        `json:"valid_points"`
	IgnoredJumpPoints    int        `json:"ignored_jump_points"`
	PathLengthM          float64    `json:"path_length_m"`
	BoundingWidthM       float64    `json:"bounding_width_m"`
	BoundingHeightM      float64    `json:"bounding_height_m"`
	StartEndDistanceM    float64    `json:"start_end_distance_m"`
	PathToPerimeter      float64    `json:"path_to_perimeter"`
	SpatialRevisitRatio  float64    `json:"spatial_revisit_ratio"`
	OutAndBackMatchRatio float64    `json:"out_and_back_match_ratio"`
}

// AnalyzeRoute classifies the full ordered trace without downsampling. Invalid
// GPS coordinates and impossible >2 km adjacent jumps do not contribute to
// any topology metric.
func AnalyzeRoute(trace []TracePoint) RouteAnalysis {
	projected, ignored := continuousProjectedTrace(projectValidTrace(trace), maxAdjacentGPSJumpM)
	analysis := RouteAnalysis{Shape: RouteShapeUnknown, ValidPoints: len(projected), IgnoredJumpPoints: ignored}
	if len(projected) < minRouteGPSPoints {
		return analysis
	}
	analysis.PathLengthM = projectedCumulativeDistances(projected)[len(projected)-1]
	analysis.BoundingWidthM, analysis.BoundingHeightM = projectedBounds(projected)
	analysis.StartEndDistanceM = projectedDistance(projected[0], projected[len(projected)-1])
	perimeter := 2 * (analysis.BoundingWidthM + analysis.BoundingHeightM)
	if perimeter > 0 {
		analysis.PathToPerimeter = analysis.PathLengthM / perimeter
	}
	analysis.SpatialRevisitRatio = spatialRevisitRatio(projected)
	analysis.OutAndBackMatchRatio = outAndBackMatchRatio(projected)

	switch {
	case isSmallRepeatedLoop(analysis):
		analysis.Shape = RouteShapeSmallRepeatedLoop
	case analysis.OutAndBackMatchRatio >= outAndBackMinMatchRatio && maxDistanceFromStart(projected) >= pointToPointMinEndpointDistanceM:
		analysis.Shape = RouteShapeOutAndBack
	case analysis.StartEndDistanceM >= pointToPointMinEndpointDistanceM:
		analysis.Shape = RouteShapeLargeLoopOrPointToPoint
	case analysis.StartEndDistanceM <= closedRouteMaxEndpointDistanceM && math.Max(analysis.BoundingWidthM, analysis.BoundingHeightM) >= largeRouteMinSpanM:
		analysis.Shape = RouteShapeLargeLoopOrPointToPoint
	}
	return analysis
}

func projectedBounds(points []projectedTracePoint) (float64, float64) {
	minX, maxX := points[0].xM, points[0].xM
	minY, maxY := points[0].yM, points[0].yM
	for _, point := range points[1:] {
		minX, maxX = math.Min(minX, point.xM), math.Max(maxX, point.xM)
		minY, maxY = math.Min(minY, point.yM), math.Max(maxY, point.yM)
	}
	return maxX - minX, maxY - minY
}

func spatialRevisitRatio(points []projectedTracePoint) float64 {
	cumulative := projectedCumulativeDistances(points)
	total := cumulative[len(cumulative)-1]
	if total < repeatedRouteMinPathM {
		return 0
	}
	visited := make(map[[2]int]struct{})
	samples := 0
	for distance := 0.0; distance <= total; distance += repeatedRouteGridSizeM {
		point := pointAtDistance(points, cumulative, distance)
		cell := [2]int{int(math.Floor(point.xM / repeatedRouteGridSizeM)), int(math.Floor(point.yM / repeatedRouteGridSizeM))}
		visited[cell] = struct{}{}
		samples++
	}
	if samples == 0 {
		return 0
	}
	return 1 - float64(len(visited))/float64(samples)
}

func isSmallRepeatedLoop(analysis RouteAnalysis) bool {
	width, height := analysis.BoundingWidthM, analysis.BoundingHeightM
	if width <= 0 || height <= 0 || math.Max(width, height) > repeatedRouteMaxBBoxM || math.Min(width, height) < repeatedRouteMinBBoxM || analysis.PathLengthM < repeatedRouteMinPathM {
		return false
	}
	return analysis.PathToPerimeter >= repeatedRoutePathToPerimeter && analysis.SpatialRevisitRatio >= repeatedRouteMinRevisitRatio
}

func outAndBackMatchRatio(points []projectedTracePoint) float64 {
	cumulative := projectedCumulativeDistances(points)
	total := cumulative[len(cumulative)-1]
	if total < 2*pointToPointMinEndpointDistanceM {
		return 0
	}
	matches, samples := 0, 0
	for outbound := outAndBackAnchorStepM; outbound < total/2; outbound += outAndBackAnchorStepM {
		a := pointAtDistance(points, cumulative, outbound)
		b := pointAtDistance(points, cumulative, total-outbound)
		if projectedDistance(a, b) <= outAndBackMatchDistanceM {
			matches++
		}
		samples++
	}
	if samples < 4 {
		return 0
	}
	return float64(matches) / float64(samples)
}

func pointAtDistance(points []projectedTracePoint, cumulative []float64, target float64) projectedTracePoint {
	index := sort.SearchFloat64s(cumulative, target)
	if index >= len(points) {
		return points[len(points)-1]
	}
	return points[index]
}

func maxDistanceFromStart(points []projectedTracePoint) float64 {
	var maximum float64
	for _, point := range points[1:] {
		maximum = math.Max(maximum, projectedDistance(points[0], point))
	}
	return maximum
}
