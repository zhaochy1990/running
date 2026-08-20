package racedetection

import (
	"math"
)

type projectedTracePoint struct {
	index int
	xM    float64
	yM    float64
}

func projectValidTrace(trace []TracePoint) []projectedTracePoint {
	var latitudeSum float64
	validCount := 0
	for _, point := range trace {
		if validTraceCoordinate(point) {
			latitudeSum += *point.Latitude
			validCount++
		}
	}
	if validCount == 0 {
		return nil
	}
	latitudeOrigin := latitudeSum / float64(validCount)
	cosLatitude := math.Cos(latitudeOrigin * math.Pi / 180)
	const earthRadiusM = 6_371_008.8
	projected := make([]projectedTracePoint, 0, validCount)
	for index, point := range trace {
		if !validTraceCoordinate(point) {
			continue
		}
		projected = append(projected, projectedTracePoint{
			index: index,
			xM:    earthRadiusM * cosLatitude * *point.Longitude * math.Pi / 180,
			yM:    earthRadiusM * *point.Latitude * math.Pi / 180,
		})
	}
	return projected
}

// continuousProjectedTrace removes isolated GPS spikes and, when the watch has
// a larger discontinuity, keeps the longest continuous segment. This prevents
// one impossible jump from inflating every topology metric derived below.
func continuousProjectedTrace(points []projectedTracePoint, maxJumpM float64) ([]projectedTracePoint, int) {
	if len(points) < 2 {
		return points, 0
	}
	withoutSpikes := make([]projectedTracePoint, 0, len(points))
	for i, point := range points {
		if i > 0 && i+1 < len(points) &&
			projectedDistance(points[i-1], point) > maxJumpM &&
			projectedDistance(point, points[i+1]) > maxJumpM &&
			projectedDistance(points[i-1], points[i+1]) <= maxJumpM {
			continue
		}
		withoutSpikes = append(withoutSpikes, point)
	}
	bestStart, bestEnd, start := 0, 1, 0
	for i := 1; i <= len(withoutSpikes); i++ {
		if i < len(withoutSpikes) && projectedDistance(withoutSpikes[i-1], withoutSpikes[i]) <= maxJumpM {
			continue
		}
		if i-start > bestEnd-bestStart {
			bestStart, bestEnd = start, i
		}
		start = i
	}
	return withoutSpikes[bestStart:bestEnd], len(points) - (bestEnd - bestStart)
}

func validTraceCoordinate(point TracePoint) bool {
	return point.Latitude != nil && point.Longitude != nil &&
		validCoordinate(*point.Latitude, *point.Longitude) &&
		!math.IsNaN(*point.Latitude) && !math.IsNaN(*point.Longitude) &&
		!math.IsInf(*point.Latitude, 0) && !math.IsInf(*point.Longitude, 0)
}

func projectedCumulativeDistances(projected []projectedTracePoint) []float64 {
	cumulative := make([]float64, len(projected))
	for i := 1; i < len(projected); i++ {
		segment := projectedDistance(projected[i-1], projected[i])
		cumulative[i] = cumulative[i-1] + segment
	}
	return cumulative
}

func projectedDistance(a, b projectedTracePoint) float64 {
	return math.Hypot(b.xM-a.xM, b.yM-a.yM)
}
